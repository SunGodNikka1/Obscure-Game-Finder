import { describe, expect, it } from "vitest";
import { RobloxThrottle, THROTTLE_CONFIG, describeThrottleEvent, parseRetryAfter } from "./throttle";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("parseRetryAfter", () => {
  it("accepts delta-seconds and HTTP-dates, rejects junk, caps absurd values", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("1.5", now)).toBe(1_500);
    expect(parseRetryAfter(new Date(now + 12_000).toUTCString(), now)).toBe(12_000);
    expect(parseRetryAfter("99999", now)).toBe(THROTTLE_CONFIG.MAX_COOLDOWN_MS);
    for (const bad of [null, undefined, "", "  ", "-5", "0", "soon", "NaN", new Date(now - 5_000).toUTCString()]) {
      expect(parseRetryAfter(bad as string | null, now)).toBeNull();
    }
  });
});

describe("RobloxThrottle", () => {
  it("has no cooldown until Roblox throttles", () => {
    const c = clock();
    const t = new RobloxThrottle({ now: c.now });
    expect(t.remainingMs()).toBe(0);
    expect(t.recordSuccess()).toBeNull();
  });

  it("first 429 opens an 8s shared cooldown", () => {
    const c = clock();
    const t = new RobloxThrottle({ now: c.now });
    const e = t.recordRateLimit(null, "resolve place 1");
    expect(e).toMatchObject({ type: "throttled", cause: "first", cooldownMs: 8_000, level: 1 });
    expect(t.remainingMs()).toBe(8_000);
  });

  it("escalates 8 -> 16 -> 32 -> 60s only when throttled again AFTER waiting, and caps at 60s", () => {
    const c = clock();
    const t = new RobloxThrottle({ now: c.now });
    const seen: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const e = t.recordRateLimit(null, "x");
      if (e?.type === "throttled") seen.push(e.cooldownMs);
      c.advance(t.remainingMs()); // wait it out, then get throttled again
    }
    expect(seen).toEqual([8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it("429s from requests already in flight during a cooldown do not escalate or log", () => {
    const c = clock();
    const t = new RobloxThrottle({ now: c.now });
    t.recordRateLimit(null, "a");
    c.advance(1_000);
    expect(t.recordRateLimit(null, "b")).toBeNull();
    expect(t.recordRateLimit(null, "c")).toBeNull();
    expect(t.escalationLevel).toBe(1);
    expect(t.remainingMs()).toBe(7_000);
  });

  it("Retry-After sets the shared cooldown (and can extend an active one)", () => {
    const c = clock();
    const t = new RobloxThrottle({ now: c.now });
    expect(t.recordRateLimit("30", "a")).toMatchObject({ cause: "retry-after", cooldownMs: 30_000 });
    expect(t.remainingMs()).toBe(30_000);
    c.advance(5_000);
    expect(t.recordRateLimit("45", "b")).toMatchObject({ cooldownMs: 45_000 });
    expect(t.remainingMs()).toBe(45_000);
    expect(t.recordRateLimit("1000000", "c")?.type).toBe("throttled"); // capped, still extends
    expect(t.remainingMs()).toBe(THROTTLE_CONFIG.MAX_COOLDOWN_MS);
  });

  it("announces a wait once per cooldown, not once per queued request", () => {
    const c = clock();
    const t = new RobloxThrottle({ now: c.now });
    t.recordRateLimit(null, "a");
    expect(t.announceWait("place 1")).toMatchObject({ type: "waiting", waitMs: 8_000 });
    expect(t.announceWait("place 2")).toBeNull();
    expect(t.announceWait("place 3")).toBeNull();
    c.advance(8_000);
    t.recordRateLimit(null, "b");
    expect(t.announceWait("place 4")?.type).toBe("waiting"); // a new cooldown is announced again
  });

  it("decays one level per SUCCESSES_PER_LEVEL answered requests and reports 'restored' at zero", () => {
    const c = clock();
    const t = new RobloxThrottle({ now: c.now });
    t.recordRateLimit(null, "a");
    c.advance(t.remainingMs());
    t.recordRateLimit(null, "b"); // level 2
    c.advance(t.remainingMs());
    const events = [];
    for (let i = 0; i < THROTTLE_CONFIG.SUCCESSES_PER_LEVEL * 2; i += 1) events.push(t.recordSuccess());
    expect(t.escalationLevel).toBe(0);
    expect(events.filter(Boolean)).toEqual([{ type: "restored" }]);
    // back to a fresh first-level cooldown next time
    expect(t.recordRateLimit(null, "c")).toMatchObject({ cause: "first", cooldownMs: 8_000 });
  });

  it("answers received during the cooldown (sent before it) do not count towards decay", () => {
    const c = clock();
    const t = new RobloxThrottle({ now: c.now });
    t.recordRateLimit(null, "a");
    for (let i = 0; i < 50; i += 1) t.recordSuccess();
    expect(t.escalationLevel).toBe(1);
  });

  it("a long quiet period resets escalation (one old 429 never slows the crawl permanently)", () => {
    const c = clock();
    const t = new RobloxThrottle({ now: c.now });
    t.recordRateLimit(null, "a");
    c.advance(t.remainingMs());
    t.recordRateLimit(null, "b"); // level 2
    c.advance(THROTTLE_CONFIG.QUIET_RESET_MS + 1);
    expect(t.recordRateLimit(null, "c")).toMatchObject({ cause: "first", cooldownMs: 8_000, level: 1 });
  });

  it("round-trips through serialisation and sanitises carried state", () => {
    const c = clock();
    const a = new RobloxThrottle({ now: c.now });
    a.recordRateLimit(null, "x");
    c.advance(3_000);
    const state = a.toState();
    expect(state).toMatchObject({ level: 1, cooldownUntil: c.now() + 5_000 });

    const b = new RobloxThrottle({ now: c.now, initialState: state });
    expect(b.remainingMs()).toBe(5_000);
    expect(b.escalationLevel).toBe(1);

    // expired cooldown between batches -> resumes normally
    c.advance(10_000);
    expect(new RobloxThrottle({ now: c.now, initialState: state }).remainingMs()).toBe(0);

    // absurd / malformed state is clamped
    const weird = new RobloxThrottle({
      now: c.now,
      initialState: { cooldownUntil: c.now() + 10 * 60_000, level: 999, successes: -4, lastThrottleAt: Number.NaN },
    });
    expect(weird.remainingMs()).toBe(THROTTLE_CONFIG.MAX_COOLDOWN_MS);
    expect(weird.escalationLevel).toBe(THROTTLE_CONFIG.COOLDOWN_STEPS_MS.length);
    expect(new RobloxThrottle({ now: c.now, initialState: null }).remainingMs()).toBe(0);
  });

  it("log wording", () => {
    expect(describeThrottleEvent({ type: "throttled", cause: "first", cooldownMs: 8_000, level: 1, label: "x" }).message).toBe(
      "[THROTTLE] Roblox rate limit detected · global cooldown 8s",
    );
    expect(describeThrottleEvent({ type: "throttled", cause: "escalated", cooldownMs: 16_000, level: 2, label: "x" }).message).toBe(
      "[THROTTLE] repeated rate limit · cooldown increased to 16s",
    );
    expect(describeThrottleEvent({ type: "restored" })).toEqual({
      level: "ok",
      message: "[THROTTLE] Roblox responding normally · normal pacing restored",
    });
  });
});

describe("Retry-After is a floor, not a ceiling", () => {
  it("honours Retry-After exactly the first time, then escalates past it on repeated throttling", () => {
    const c = clock();
    const t = new RobloxThrottle({ now: c.now });
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const e = t.recordRateLimit("5", "resolve place 1"); // what apis.roblox.com actually sends
      if (e?.type === "throttled") seen.push(`${e.cause}:${e.cooldownMs}`);
      c.advance(t.remainingMs());
    }
    expect(seen).toEqual(["retry-after:5000", "escalated:16000", "escalated:32000", "escalated:60000", "escalated:60000"]);
  });

  it("never waits less than a large Retry-After, even when escalating", () => {
    const c = clock();
    const t = new RobloxThrottle({ now: c.now });
    t.recordRateLimit(null, "a"); // 8s
    c.advance(t.remainingMs());
    expect(t.recordRateLimit("45", "b")).toMatchObject({ cause: "retry-after", cooldownMs: 45_000 });
  });
});
