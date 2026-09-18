import { sql } from "drizzle-orm";
import { db, isDatabaseConfigured } from "@/db";

/**
 * SERVER-SIDE ABUSE PROTECTION (env-gated, disabled by default)
 *
 * IMPORTANT SECURITY NOTE
 * -----------------------
 * The crawler request budget carried in the Continuous ∞ payload
 * (`budgetState`) is **UX and politeness state, not security**. It is supplied
 * by the client, so any caller can simply omit it and receive a fresh bucket.
 * It exists to make the UI counters truthful and to keep the crawler polite --
 * it must never be mistaken for enforcement.
 *
 * Real protection for a public deployment therefore needs an external,
 * server-authoritative layer keyed by IP (or session/API key). This module
 * provides exactly that with a fixed-window counter in Postgres, which works
 * on serverless/multi-instance hosting because the state lives in the database
 * rather than in process memory.
 *
 * ENABLING
 *   RATE_LIMIT_ENABLED=1                 # turn the limiter on
 *   RATE_LIMIT_WINDOW_SECONDS=60         # optional global default window
 *   RATE_LIMIT_MAX_REQUESTS=30           # optional global default quota per route per window
 *
 * PER-ROUTE QUOTAS
 *   Each protected route has its own default quota (see ROUTE_QUOTAS). Any of
 *   them can be overridden with a route-suffixed variable, e.g.
 *   RATE_LIMIT_MAX_REQUESTS_ARCHIVE=5 / RATE_LIMIT_WINDOW_SECONDS_ARCHIVE=3600
 *   (route name upper-cased, "-" replaced by "_"). Route-suffixed variables win
 *   over the global ones, which win over the built-in defaults.
 *
 * Requires the `rate_limit_hits` table (see `src/db/schema.ts`,
 * created with `npx drizzle-kit push`).
 *
 * Left DISABLED for Arena/local testing, where no shared persistent store is
 * guaranteed and the preview is single-tenant. If you deploy this publicly,
 * turn it on, or place the app behind your host's own rate limiter
 * (Vercel Firewall, Cloudflare, an API gateway, etc.).
 */

const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_MAX_REQUESTS = 30;

/** `process.env`-shaped input; kept loose so tests can pass plain objects. */
export type EnvLike = Record<string, string | undefined>;

export interface RouteQuota {
  maxRequests: number;
  windowSeconds: number;
}

/**
 * Built-in per-route quotas. Sized to what a single honest browser session can
 * plausibly do: a continuous batch takes ~30-50s, a finite scan up to ~110s,
 * an import is a one-off paste, and an archive write stores up to 500 rows.
 */
export const ROUTE_QUOTAS: Readonly<Record<string, RouteQuota>> = {
  "scan-batch": { maxRequests: 30, windowSeconds: 60 },
  scan: { maxRequests: 10, windowSeconds: 60 },
  import: { maxRequests: 20, windowSeconds: 60 },
  archive: { maxRequests: 10, windowSeconds: 3600 },
};

export function isRateLimitEnabled(): boolean {
  return process.env.RATE_LIMIT_ENABLED === "1" && isDatabaseConfigured();
}

function readIntEnv(name: string, fallback: number, env: EnvLike = process.env): number {
  const parsed = Number(env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** `scan-batch` -> `SCAN_BATCH`, used as the env-variable suffix. */
function envSuffix(route: string): string {
  return route.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Effective quota for a route: route-suffixed env > global env > built-in
 * default for that route > module default. Pure; `env` is injectable for tests.
 */
export function resolveRouteQuota(route: string, env: EnvLike = process.env): RouteQuota {
  const builtIn = ROUTE_QUOTAS[route];
  const suffix = envSuffix(route);
  const globalMax = readIntEnv("RATE_LIMIT_MAX_REQUESTS", builtIn?.maxRequests ?? DEFAULT_MAX_REQUESTS, env);
  const globalWindow = readIntEnv("RATE_LIMIT_WINDOW_SECONDS", builtIn?.windowSeconds ?? DEFAULT_WINDOW_SECONDS, env);
  return {
    maxRequests: readIntEnv(`RATE_LIMIT_MAX_REQUESTS_${suffix}`, globalMax, env),
    windowSeconds: readIntEnv(`RATE_LIMIT_WINDOW_SECONDS_${suffix}`, globalWindow, env),
  };
}

/**
 * Best-effort client identity. Behind a proxy the left-most `x-forwarded-for`
 * entry is the closest thing to a real client IP we can see.
 */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return (
    request.headers.get("x-real-ip")?.slice(0, 64) ??
    request.headers.get("cf-connecting-ip")?.slice(0, 64) ??
    "unknown"
  );
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

/**
 * Fixed-window counter. One UPSERT per call; the window is derived from the
 * clock so no cleanup job is required for correctness (old rows are simply
 * never read again and can be pruned lazily).
 */
export async function checkRateLimit(request: Request, route: string): Promise<RateLimitVerdict> {
  const { windowSeconds, maxRequests } = resolveRouteQuota(route);
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000;
  const identity = `${clientKey(request)}:${route}`;

  try {
    const result = await db.execute<{ hits: number }>(sql`
      insert into rate_limit_hits (identity, window_start, hits)
      values (${identity}, ${new Date(windowStart)}, 1)
      on conflict (identity, window_start)
      do update set hits = rate_limit_hits.hits + 1
      returning hits
    `);

    const rows = (result as unknown as { rows?: Array<{ hits: number }> }).rows ?? [];
    const hits = Number(rows[0]?.hits ?? 1);
    const resetSeconds = Math.max(1, Math.ceil((windowStart + windowSeconds * 1000 - now) / 1000));

    return {
      allowed: hits <= maxRequests,
      remaining: Math.max(0, maxRequests - hits),
      resetSeconds,
    };
  } catch (error) {
    // Fail OPEN: a limiter outage must not take the application down.
    if (process.env.NODE_ENV !== "production") console.error("[rateLimit]", error);
    return { allowed: true, remaining: maxRequests, resetSeconds: windowSeconds };
  }
}

/**
 * Convenience guard for route handlers.
 * Returns a 429 `Response` when the caller is over quota, otherwise `null`.
 */
export async function enforceRateLimit(request: Request, route: string): Promise<Response | null> {
  if (!isRateLimitEnabled()) return null;
  const verdict = await checkRateLimit(request, route);
  if (verdict.allowed) return null;
  return Response.json(
    { error: "Rate limit exceeded. Please slow down." },
    {
      status: 429,
      headers: {
        "retry-after": String(verdict.resetSeconds),
        "x-ratelimit-remaining": "0",
      },
    },
  );
}
