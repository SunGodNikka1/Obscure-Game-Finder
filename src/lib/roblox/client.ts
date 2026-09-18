/**
 * Centralised Roblox HTTP client.
 *
 * Every Roblox request in this project goes through this file. That gives us:
 *  - a hard allowlist of Roblox hostnames (no SSRF: callers pass a host *key*
 *    plus a path, never a full URL)
 *  - per-request timeouts
 *  - retries with backoff for transient failures (network / 5xx)
 *  - rate-limit (HTTP 429) awareness with `retry-after` support
 *  - request counting (surfaced in the UI as the `HTTP:` metric)
 *  - in-scan response de-duplication / memoisation
 *  - lightweight response validation
 */

import { RequestBudget, type BudgetKind } from "./budget";

export const ROBLOX_HOSTS = {
  users: "https://users.roblox.com",
  games: "https://games.roblox.com",
  friends: "https://friends.roblox.com",
  thumbnails: "https://thumbnails.roblox.com",
  apis: "https://apis.roblox.com",
  inventory: "https://inventory.roblox.com",
} as const;

export type RobloxHostKey = keyof typeof ROBLOX_HOSTS;

export const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;
/** Longest single sleep while waiting for a budget refill (loops until granted). */
const MAX_BUDGET_WAIT_MS = 61_000;

export class ScanAbortedError extends Error {
  constructor(message = "Scan aborted by user.") {
    super(message);
    this.name = "ScanAbortedError";
  }
}

export class RobloxApiError extends Error {
  readonly status: number | null;
  readonly label: string;

  constructor(message: string, status: number | null, label: string) {
    super(message);
    this.name = "RobloxApiError";
    this.status = status;
    this.label = label;
  }
}

export interface RobloxRequestOptions {
  host: RobloxHostKey;
  /** Must start with `/`. Path segments are encoded by the caller helpers. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /** Human readable operation name used in the Processes log. */
  label: string;
  /** Which crawler-managed budget bucket this request draws from. */
  budgetKind?: BudgetKind;
  /** Skip budget accounting (used for cached/derived calls). */
  skipBudget?: boolean;
}

export interface RobloxClientEvents {
  onRequest?: (info: { count: number; label: string; url: string }) => void;
  /** Fired when a crawler budget bucket is exhausted and work must pause. */
  onBudgetWait?: (info: { kind: BudgetKind; waitMs: number; label: string }) => void;
  onRetry?: (info: {
    label: string;
    attempt: number;
    waitMs: number;
    reason: "rate-limit" | "transient";
  }) => void;
  onFailure?: (info: { label: string; status: number | null; message: string }) => void;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ScanAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new ScanAbortedError());
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function buildUrl(options: RobloxRequestOptions): string {
  const base = ROBLOX_HOSTS[options.host];
  if (!base) {
    throw new RobloxApiError(`Blocked non-allowlisted host: ${options.host}`, null, options.label);
  }
  if (!options.path.startsWith("/")) {
    throw new RobloxApiError("Invalid request path", null, options.label);
  }
  const url = new URL(base + options.path);
  if (url.origin !== base) {
    // Defensive: a crafted path can never escape the allowlisted origin.
    throw new RobloxApiError("Blocked request outside Roblox allowlist", null, options.label);
  }
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export class RobloxClient {
  requestCount = 0;
  failureCount = 0;
  rateLimitHits = 0;

  /** Crawler-managed safety budgets (see budget.ts). */
  readonly budget: RequestBudget;

  private readonly signal?: AbortSignal;
  private readonly events: RobloxClientEvents;
  private readonly defaultTimeout: number;
  private readonly cache = new Map<string, unknown>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    opts: {
      signal?: AbortSignal;
      events?: RobloxClientEvents;
      timeoutMs?: number;
      budget?: RequestBudget;
    } = {},
  ) {
    this.signal = opts.signal;
    this.events = opts.events ?? {};
    this.defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.budget = opts.budget ?? new RequestBudget();
  }

  get aborted(): boolean {
    return this.signal?.aborted ?? false;
  }

  throwIfAborted(): void {
    if (this.signal?.aborted) throw new ScanAbortedError();
  }

  async request<T>(options: RobloxRequestOptions): Promise<T> {
    this.throwIfAborted();
    const url = buildUrl(options);
    const method = options.method ?? "GET";
    const key = `${method} ${url} ${options.body ? JSON.stringify(options.body) : ""}`;

    if (this.cache.has(key)) return this.cache.get(key) as T;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = this.execute<T>(url, method, options)
      .then((value) => {
        this.cache.set(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private async execute<T>(
    url: string,
    method: "GET" | "POST",
    options: RobloxRequestOptions,
  ): Promise<T> {
    const retries = options.retries ?? DEFAULT_RETRIES;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeout;
    let lastError: RobloxApiError | null = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      this.throwIfAborted();

      // Crawler-managed budget gate: pause (do not drop) when a bucket is dry.
      if (!options.skipBudget) {
        const kind: BudgetKind = options.budgetKind ?? "general";
        let waitMs = this.budget.reserve(kind);
        while (waitMs > 0) {
          this.events.onBudgetWait?.({ kind, waitMs, label: options.label });
          await sleep(Math.min(waitMs + 50, MAX_BUDGET_WAIT_MS), this.signal);
          waitMs = this.budget.reserve(kind);
        }
      }

      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      this.signal?.addEventListener("abort", onOuterAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      this.requestCount += 1;
      this.events.onRequest?.({ count: this.requestCount, label: options.label, url });

      try {
        const response = await fetch(url, {
          method,
          signal: controller.signal,
          cache: "no-store",
          headers: {
            accept: "application/json",
            "user-agent": "ObscureGameFinder/1.0 (public data archaeology tool)",
            ...(options.body ? { "content-type": "application/json" } : {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
        });

        if (response.status === 429) {
          this.rateLimitHits += 1;
          const retryAfter = Number(response.headers.get("retry-after"));
          const waitMs = Math.min(
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2500 * (attempt + 1),
            MAX_RETRY_WAIT_MS,
          );
          lastError = new RobloxApiError("Rate limited by Roblox", 429, options.label);
          if (attempt === retries) break;
          this.events.onRetry?.({ label: options.label, attempt: attempt + 1, waitMs, reason: "rate-limit" });
          await sleep(waitMs, this.signal);
          continue;
        }

        if (response.status >= 500) {
          lastError = new RobloxApiError(`Roblox responded ${response.status}`, response.status, options.label);
          if (attempt === retries) break;
          const waitMs = Math.min(700 * 2 ** attempt, MAX_RETRY_WAIT_MS);
          this.events.onRetry?.({ label: options.label, attempt: attempt + 1, waitMs, reason: "transient" });
          await sleep(waitMs, this.signal);
          continue;
        }

        if (!response.ok) {
          // 400 / 401 / 403 / 404 are terminal: retrying will not help.
          throw new RobloxApiError(
            response.status === 404
              ? "Not found"
              : response.status === 401 || response.status === 403
                ? "Information is private or requires authentication"
                : `Roblox responded ${response.status}`,
            response.status,
            options.label,
          );
        }

        const parsed = (await response.json()) as unknown;
        if (parsed === null || typeof parsed !== "object") {
          throw new RobloxApiError("Malformed Roblox response", response.status, options.label);
        }
        return parsed as T;
      } catch (error) {
        if (this.signal?.aborted) throw new ScanAbortedError();
        if (error instanceof RobloxApiError) {
          this.failureCount += 1;
          this.events.onFailure?.({ label: options.label, status: error.status, message: error.message });
          throw error;
        }
        const message = error instanceof Error ? error.message : "Network failure";
        lastError = new RobloxApiError(
          message.includes("aborted") ? "Request timed out" : message,
          null,
          options.label,
        );
        if (attempt === retries) break;
        const waitMs = Math.min(700 * 2 ** attempt, MAX_RETRY_WAIT_MS);
        this.events.onRetry?.({ label: options.label, attempt: attempt + 1, waitMs, reason: "transient" });
        await sleep(waitMs, this.signal);
      } finally {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", onOuterAbort);
      }
    }

    const error = lastError ?? new RobloxApiError("Unknown Roblox failure", null, options.label);
    this.failureCount += 1;
    this.events.onFailure?.({ label: error.label, status: error.status, message: error.message });
    throw error;
  }
}

export function isAbort(error: unknown): error is ScanAbortedError {
  return error instanceof ScanAbortedError || (error instanceof Error && error.name === "AbortError");
}

export function describeError(error: unknown): string {
  if (error instanceof RobloxApiError) {
    return error.status ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return "Unexpected failure";
}
