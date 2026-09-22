import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestBudget, BUDGET_CONFIG } from "./budget";
import { RobloxApiError, RobloxClient, RobloxThrottleDeferredError, ScanAbortedError, isRateLimited } from "./client";
import { RobloxThrottle, THROTTLE_CONFIG, type ThrottleEvent } from "./throttle";

/**
 * Client behaviour against a mocked `fetch` with fake timers: every wait is
 * virtual, and `calls` records the (virtual) time each real fetch happened.
 */
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

let calls: Array<{ url: string; at: number }>;
let replies: Map<string, Reply[]>;
const T0 = Date.parse("2026-09-22T12:00:00Z");

function reply(match: string, ...sequence: Reply[]) {
  replies.set(match, sequence);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  calls = [];
  replies = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push({ url, at: Date.now() });
      const key = Array.from(replies.keys()).find((k) => url.includes(k));
      const queue = key ? replies.get(key)! : [];
      const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? { status: 200, body: { ok: true } });
      return new Response(JSON.stringify(next.body ?? { ok: true }), { status: next.status, headers: next.headers });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeClient(opts: { deadline?: number; signal?: AbortSignal; budget?: RequestBudget } = {}) {
  const events: ThrottleEvent[] = [];
  const client = new RobloxClient({ ...opts, events: { onThrottle: (e) => events.push(e) } });
  return { client, events };
}

/** Run a request to completion while advancing virtual time. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const out: { value?: T; error?: unknown } = {};
  const done = promise.then((v) => (out.value = v)).catch((e) => (out.error = e));
  await vi.runAllTimersAsync();
  await done;
  return out;
}

const get = (client: RobloxClient, host: "games" | "users" | "apis" | "inventory", path: string, retries?: number) =>
  client.request<{ ok?: boolean }>({ host, path, label: path, retries });

describe("RobloxClient shared cooldown", () => {
  it("1. normal successful requests get no added delay", async () => {
    const { client } = makeClient();
    for (let i = 0; i < 5; i += 1) await settle(get(client, "games", `/v1/ok/${i}`));
    expect(calls.map((c) => c.at - T0)).toEqual([0, 0, 0, 0, 0]);
    expect(client.throttle.remainingMs()).toBe(0);
  });

  it("2. the first 429 creates a shared cooldown and is logged once", async () => {
    const { client, events } = makeClient();
    reply("/v1/place/1", { status: 429 });
    const r = await settle(get(client, "apis", "/v1/place/1", 0));
    expect(isRateLimited(r.error)).toBe(true);
    expect(events).toEqual([expect.objectContaining({ type: "throttled", cause: "first", cooldownMs: 8_000 })]);
    expect(client.throttle.remainingMs()).toBe(8_000);
  });

  it("3. a DIFFERENT endpoint on another host respects that same cooldown", async () => {
    const { client, events } = makeClient();
    reply("/v1/place/1", { status: 429 });
    await settle(get(client, "apis", "/v1/place/1", 0));
    const start = Date.now();
    await settle(get(client, "users", "/v1/users/42"));
    const userCall = calls.find((c) => c.url.includes("/v1/users/42"))!;
    expect(userCall.at - start).toBe(8_000);
    expect(events.filter((e) => e.type === "waiting")).toHaveLength(1);
  });

  it("does not hammer Roblox after a request exhausts its retries: queued requests all wait, one wait log", async () => {
    const { client, events } = makeClient();
    reply("/v1/place/1", { status: 429 });
    await settle(get(client, "apis", "/v1/place/1", 0));
    const start = Date.now();
    await settle(Promise.all([2, 3, 4, 5].map((n) => get(client, "apis", `/v1/place/${n}`))));
    const later = calls.filter((c) => !c.url.includes("/place/1"));
    expect(later).toHaveLength(4);
    expect(later.every((c) => c.at - start >= 8_000)).toBe(true);
    expect(events.filter((e) => e.type === "waiting")).toHaveLength(1);
  });

  it("4. repeated 429s increase the cooldown (8s -> 16s -> 32s) and the request's own retries wait on it", async () => {
    const { client, events } = makeClient();
    reply("/v1/place/9", { status: 429 }); // always throttled
    const r = await settle(get(client, "apis", "/v1/place/9")); // 3 attempts
    expect(isRateLimited(r.error)).toBe(true);
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
    expect(gaps).toEqual([8_000, 16_000]);
    expect(events.filter((e) => e.type === "throttled").map((e) => (e as { cooldownMs: number }).cooldownMs)).toEqual([
      8_000, 16_000, 32_000,
    ]);
  });

  it("5. Retry-After is honoured and applies to every later request", async () => {
    const { client } = makeClient();
    reply("/v1/place/1", { status: 429, headers: { "retry-after": "30" } });
    await settle(get(client, "apis", "/v1/place/1", 0));
    const start = Date.now();
    await settle(get(client, "games", "/v1/games/other"));
    expect(calls.at(-1)!.at - start).toBe(30_000);
  });

  it("6. absurd Retry-After and long escalation are capped at 60s", async () => {
    const { client } = makeClient();
    reply("/v1/place/1", { status: 429, headers: { "retry-after": "86400" } });
    await settle(get(client, "apis", "/v1/place/1", 0));
    expect(client.throttle.remainingMs()).toBe(THROTTLE_CONFIG.MAX_COOLDOWN_MS);
    reply("/v1/place/2", { status: 429 });
    for (let i = 0; i < 6; i += 1) await settle(get(client, "apis", "/v1/place/2", 0));
    expect(client.throttle.remainingMs()).toBeLessThanOrEqual(THROTTLE_CONFIG.MAX_COOLDOWN_MS);
  });

  it("7. successful responses decay the throttle and restore normal pacing", async () => {
    const { client, events } = makeClient();
    reply("/v1/place/1", { status: 429 });
    await settle(get(client, "apis", "/v1/place/1", 0));
    for (let i = 0; i < THROTTLE_CONFIG.SUCCESSES_PER_LEVEL; i += 1) await settle(get(client, "games", `/v1/ok/${i}`));
    expect(events.at(-1)).toEqual({ type: "restored" });
    expect(client.throttle.escalationLevel).toBe(0);
    const start = Date.now();
    await settle(get(client, "games", "/v1/ok/fast"));
    expect(calls.at(-1)!.at - start).toBe(0); // no added delay any more
  });

  it("8. aborting during a cooldown exits immediately", async () => {
    const controller = new AbortController();
    const { client } = makeClient({ signal: controller.signal });
    reply("/v1/place/1", { status: 429 });
    await settle(get(client, "apis", "/v1/place/1", 0));
    const pending = get(client, "games", "/v1/games/x");
    const outcome = pending.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    expect(await outcome).toBeInstanceOf(ScanAbortedError);
    expect(calls.some((c) => c.url.includes("/v1/games/x"))).toBe(false);
  });

  it("9. 403 stays terminal and does not create a cooldown", async () => {
    const { client, events } = makeClient();
    reply("/v2/users/1/inventory", { status: 403 });
    const r = await settle(get(client, "inventory", "/v2/users/1/inventory/9"));
    expect((r.error as RobloxApiError).status).toBe(403);
    expect(isRateLimited(r.error)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(client.throttle.remainingMs()).toBe(0);
    expect(events).toEqual([]);
  });

  it("10. 404 stays terminal and does not create a cooldown", async () => {
    const { client } = makeClient();
    reply("/v1/games/missing", { status: 404 });
    const r = await settle(get(client, "games", "/v1/games/missing"));
    expect((r.error as RobloxApiError).status).toBe(404);
    expect(calls).toHaveLength(1);
    expect(client.throttle.remainingMs()).toBe(0);
  });

  it("11. 5xx keeps its existing transient retry (700ms backoff, no shared cooldown)", async () => {
    const { client } = makeClient();
    reply("/v1/flaky", { status: 503 }, { status: 200, body: { ok: true } });
    const r = await settle(get(client, "games", "/v1/flaky"));
    expect(r.value).toEqual({ ok: true });
    expect(calls.map((c) => c.at - T0)).toEqual([0, 700]);
    expect(client.throttle.remainingMs()).toBe(0);
  });

  it("defers (no network, no budget) when the cooldown would outlast the deadline", async () => {
    const budget = new RequestBudget();
    const { client } = makeClient({ deadline: T0 + 10_000, budget });
    reply("/v1/place/1", { status: 429, headers: { "retry-after": "30" } });
    await settle(get(client, "apis", "/v1/place/1", 0));
    const tokens = budget.snapshot().http;
    const failures = client.failureCount;
    const requests = client.requestCount;
    const r = await settle(get(client, "games", "/v1/games/x"));
    expect(r.error).toBeInstanceOf(RobloxThrottleDeferredError);
    expect(isRateLimited(r.error)).toBe(true);
    expect(calls.some((c) => c.url.includes("/v1/games/x"))).toBe(false);
    expect(budget.snapshot().http).toBe(tokens);
    expect(client.failureCount).toBe(failures);
    expect(client.requestCount).toBe(requests);
  });

  it("still waits when the cooldown ends comfortably before the deadline", async () => {
    const { client } = makeClient({ deadline: T0 + 40_000 });
    reply("/v1/place/1", { status: 429 });
    await settle(get(client, "apis", "/v1/place/1", 0));
    const r = await settle(get(client, "games", "/v1/games/x"));
    expect(r.value).toEqual({ ok: true });
    expect(calls.at(-1)!.at - T0).toBe(8_000);
  });

  it("15. budget accounting and counters are unchanged: one token + one request per real attempt", async () => {
    const budget = new RequestBudget();
    const { client } = makeClient({ budget });
    reply("/v1/place/9", { status: 429 });
    await settle(get(client, "apis", "/v1/place/9")); // 3 real attempts, all throttled
    await settle(get(client, "games", "/v1/ok")); // 1 real attempt
    expect(client.requestCount).toBe(4);
    expect(client.rateLimitHits).toBe(3);
    expect(client.failureCount).toBe(1);
    expect(budget.snapshot().http).toBe(BUDGET_CONFIG.HTTP_PER_WINDOW - 4);
  });

  it("accepts an injected (carried) throttle", async () => {
    const throttle = new RobloxThrottle({ initialState: { cooldownUntil: T0 + 5_000, level: 1, successes: 0, lastThrottleAt: T0 } });
    const client = new RobloxClient({ throttle });
    await settle(get(client, "games", "/v1/ok"));
    expect(calls[0].at - T0).toBe(5_000);
  });
});
