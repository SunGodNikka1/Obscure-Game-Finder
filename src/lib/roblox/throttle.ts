/**
 * SHARED ADAPTIVE ROBLOX COOLDOWN
 *
 * `RequestBudget` (budget.ts) is our PROACTIVE politeness limit. This is the
 * REACTIVE half: when Roblox itself answers HTTP 429 on ANY endpoint, every
 * Roblox request made through the same RobloxClient pauses until the shared
 * cooldown expires -- one global gate, never per-URL.
 *
 *   - No throttle, no delay: when Roblox is accepting requests nothing waits.
 *   - A valid `Retry-After` header is honoured as a FLOOR (clamped to
 *     MAX_COOLDOWN_MS): it sets the first cooldown exactly, but repeated
 *     throttling still escalates past it. (Live: apis.roblox.com answers
 *     `Retry-After: 5` every time; honouring it verbatim re-hit Roblox every 5s.)
 *   - Escalation with repeated throttling:
 *       8s -> 16s -> 32s -> 60s (cap)
 *     A 429 only escalates when it arrives AFTER the previous cooldown ended
 *     (i.e. we waited and Roblox still refused). 429s from requests that were
 *     already in flight during a cooldown just keep the existing one.
 *   - Decay: every SUCCESSES_PER_LEVEL answered requests after a cooldown
 *     drop the escalation one level; after QUIET_RESET_MS without a 429 it
 *     resets entirely. One old 429 never slows the crawl permanently.
 *
 * Pure and clock-injectable so it is deterministic under test, and
 * serialisable so Continuous ∞ batches (a fresh stateless request each) do
 * not forget that Roblox throttled the previous batch.
 */

export const THROTTLE_CONFIG = {
  /** Cooldown per escalation level (level 1 = first throttle). */
  COOLDOWN_STEPS_MS: [8_000, 16_000, 32_000, 60_000] as const,
  /** Hard ceiling for any cooldown, including Retry-After. */
  MAX_COOLDOWN_MS: 60_000,
  /** Answered requests (after the cooldown) needed to drop one escalation level. */
  SUCCESSES_PER_LEVEL: 10,
  /** No 429 for this long -> escalation resets to zero. */
  QUIET_RESET_MS: 120_000,
} as const;

export interface SerializedThrottleState {
  /** Epoch ms until which all Roblox requests should wait (0 = none). */
  cooldownUntil: number;
  /** 0 = not throttled; 1..n = escalation level. */
  level: number;
  /** Answered requests since the last level change. */
  successes: number;
  /** Epoch ms of the most recent 429 (0 = never). */
  lastThrottleAt: number;
}

export type ThrottleEvent =
  | {
      type: "throttled";
      /** first = new episode, escalated = repeated after waiting, retry-after = Roblox told us. */
      cause: "first" | "escalated" | "retry-after";
      cooldownMs: number;
      level: number;
      label: string;
    }
  | { type: "waiting"; waitMs: number; label: string }
  | { type: "restored" };

const MAX_LEVEL = THROTTLE_CONFIG.COOLDOWN_STEPS_MS.length;

/**
 * Parse a Retry-After header: delta-seconds or an HTTP-date. Returns ms, or
 * null when absent / malformed / non-positive. Never exceeds MAX_COOLDOWN_MS.
 */
export function parseRetryAfter(raw: string | null | undefined, now: number): number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (!text) return null;
  let ms: number | null = null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (Number.isFinite(at)) ms = at - now;
  }
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(Math.ceil(ms), THROTTLE_CONFIG.MAX_COOLDOWN_MS);
}

export function escalationCooldownMs(level: number): number {
  const index = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level))) - 1;
  return THROTTLE_CONFIG.COOLDOWN_STEPS_MS[index];
}

function finiteNonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export class RobloxThrottle {
  private cooldownUntil = 0;
  private level = 0;
  private successes = 0;
  private lastThrottleAt = 0;
  /** cooldownUntil value already announced by a "waiting" event (avoids one log per queued request). */
  private announcedUntil = 0;
  private readonly now: () => number;

  constructor(options: { initialState?: SerializedThrottleState | null; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    const state = options.initialState;
    if (state && typeof state === "object") {
      const now = this.now();
      // Never trust a carried cooldown further out than the cap allows.
      this.cooldownUntil = Math.min(finiteNonNegative(state.cooldownUntil), now + THROTTLE_CONFIG.MAX_COOLDOWN_MS);
      this.level = Math.min(MAX_LEVEL, Math.floor(finiteNonNegative(state.level)));
      this.successes = Math.floor(finiteNonNegative(state.successes));
      this.lastThrottleAt = Math.min(finiteNonNegative(state.lastThrottleAt), now);
      this.applyQuietReset(now);
    }
  }

  /** Remaining shared cooldown in ms (0 when Roblox may be called now). */
  remainingMs(now = this.now()): number {
    return Math.max(0, this.cooldownUntil - now);
  }

  get escalationLevel(): number {
    return this.level;
  }

  /**
   * Returns a "waiting" event the first time a given cooldown is waited on,
   * null for every later request queued behind the same cooldown.
   */
  announceWait(label: string, now = this.now()): ThrottleEvent | null {
    const waitMs = this.remainingMs(now);
    if (waitMs <= 0 || this.announcedUntil === this.cooldownUntil) return null;
    this.announcedUntil = this.cooldownUntil;
    return { type: "waiting", waitMs, label };
  }

  /** Record an HTTP 429. Returns an event only when the shared cooldown changed. */
  recordRateLimit(retryAfterHeader: string | null | undefined, label: string, now = this.now()): ThrottleEvent | null {
    this.applyQuietReset(now);
    const inActiveCooldown = now < this.cooldownUntil;
    this.lastThrottleAt = now;
    this.successes = 0;

    const retryAfterMs = parseRetryAfter(retryAfterHeader, now);

    if (inActiveCooldown && retryAfterMs === null) {
      // A request that was already in flight: the episode is known, don't escalate.
      return null;
    }

    const previousLevel = this.level;
    if (!inActiveCooldown) this.level = Math.min(MAX_LEVEL, this.level + 1);
    // First throttle: Retry-After if given, else step 1. Repeated throttle
    // (after waiting): escalate, never below what Roblox asked for.
    const escalating = !inActiveCooldown && previousLevel > 0;
    const cooldownMs = escalating
      ? Math.max(retryAfterMs ?? 0, escalationCooldownMs(this.level))
      : (retryAfterMs ?? escalationCooldownMs(this.level));
    const until = now + cooldownMs;
    if (until <= this.cooldownUntil) return null;
    this.cooldownUntil = until;

    const cause =
      escalating && cooldownMs > (retryAfterMs ?? 0) ? "escalated" : retryAfterMs !== null ? "retry-after" : "first";
    return { type: "throttled", cause, cooldownMs, level: this.level, label };
  }

  /**
   * Record a request Roblox actually answered (anything but 429/5xx/network).
   * Returns "restored" once escalation has fully decayed back to normal.
   */
  recordSuccess(now = this.now()): ThrottleEvent | null {
    if (this.level === 0) return null;
    if (now < this.cooldownUntil) return null; // an in-flight answer from before the throttle
    this.successes += 1;
    if (this.successes < THROTTLE_CONFIG.SUCCESSES_PER_LEVEL) return null;
    this.successes = 0;
    this.level -= 1;
    return this.level === 0 ? { type: "restored" } : null;
  }

  toState(now = this.now()): SerializedThrottleState {
    this.applyQuietReset(now);
    return {
      cooldownUntil: this.cooldownUntil > now ? this.cooldownUntil : 0,
      level: this.level,
      successes: this.successes,
      lastThrottleAt: this.lastThrottleAt,
    };
  }

  private applyQuietReset(now: number): void {
    if (this.level > 0 && this.lastThrottleAt > 0 && now - this.lastThrottleAt >= THROTTLE_CONFIG.QUIET_RESET_MS && now >= this.cooldownUntil) {
      this.level = 0;
      this.successes = 0;
    }
  }
}

/** Processes-log wording shared by finite scans and Continuous batches. */
export function describeThrottleEvent(event: ThrottleEvent): { level: "warn" | "ok"; message: string } {
  if (event.type === "restored") {
    return { level: "ok", message: "[THROTTLE] Roblox responding normally · normal pacing restored" };
  }
  if (event.type === "waiting") {
    return {
      level: "warn",
      message: `[THROTTLE] shared cooldown · pausing all Roblox requests for ${Math.ceil(event.waitMs / 1000)}s (next: ${event.label})`,
    };
  }
  const seconds = Math.ceil(event.cooldownMs / 1000);
  const message =
    event.cause === "retry-after"
      ? `[THROTTLE] Roblox asked us to wait (Retry-After) · global cooldown ${seconds}s`
      : event.cause === "first"
        ? `[THROTTLE] Roblox rate limit detected · global cooldown ${seconds}s`
        : `[THROTTLE] repeated rate limit · cooldown increased to ${seconds}s`;
  return { level: "warn", message };
}
