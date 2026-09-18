/**
 * CRAWLER REQUEST BUDGETS (token buckets with a fixed refill window).
 *
 * The original Obscure Game Finder ran inside Roblox and showed the HTTP /
 * FriendList request allowances the Roblox engine granted it ("Available HTTP
 * and FriendList requests were set by Roblox and cannot be increased.
 * Requests refresh every 60 seconds.").
 *
 * A website cannot honestly claim those engine quotas. Instead these are
 * **crawler-managed safety budgets**: limits this application imposes on
 * itself so it stays a polite citizen of the Roblox web API. The numbers shown
 * in the UI are the real remaining tokens of these buckets -- nothing is faked
 * -- and the labels are kept so the interface still reads like the original.
 *
 * Two independent buckets, mirroring the original's two counters:
 *   general -> every Roblox call except friend lists
 *   friends -> friends.roblox.com calls (far scarcer, as in the original)
 *
 * Both refill completely every REFILL_WINDOW_MS. When a bucket is empty the
 * crawler *pauses* that class of request until the next refill instead of
 * hammering Roblox.
 */

export const BUDGET_CONFIG = {
  /** General Roblox requests granted per window. */
  HTTP_PER_WINDOW: 400,
  /** Friend-list requests granted per window. */
  FRIENDS_PER_WINDOW: 20,
  /** Refill window, matching the original's 60 second cadence. */
  REFILL_WINDOW_MS: 60_000,
} as const;

export type BudgetKind = "general" | "friends";

export interface BudgetSnapshot {
  http: number;
  friends: number;
  /** Whole seconds until the current window refills. */
  refreshSeconds: number;
}

export interface BudgetWaitEvent {
  kind: BudgetKind;
  waitMs: number;
}

/**
 * Serializable state for carrying crawler-managed budgets across batch boundaries
 * in Continuous ∞ mode.
 */
export interface SerializedBudgetState {
  generalRemaining: number;
  friendRemaining: number;
  windowStartedAt: number;
}

export class RequestBudget {
  private general: number;
  private friends: number;
  private windowStart: number;
  private readonly onWait?: (event: BudgetWaitEvent) => void;

  constructor(
    options: {
      onWait?: (event: BudgetWaitEvent) => void;
      initialState?: SerializedBudgetState | null;
    } = {},
  ) {
    this.onWait = options.onWait;

    if (options.initialState && typeof options.initialState === "object") {
      const now = Date.now();
      const rawWindow = Number(options.initialState.windowStartedAt);
      // Valid window timestamp must be finite, not in future, and reasonable.
      this.windowStart =
        Number.isFinite(rawWindow) && rawWindow > 0 && rawWindow <= now
          ? rawWindow
          : now;

      const rawGeneral = Number(options.initialState.generalRemaining);
      this.general = Number.isFinite(rawGeneral)
        ? Math.max(0, Math.min(BUDGET_CONFIG.HTTP_PER_WINDOW, Math.floor(rawGeneral)))
        : BUDGET_CONFIG.HTTP_PER_WINDOW;

      const rawFriends = Number(options.initialState.friendRemaining);
      this.friends = Number.isFinite(rawFriends)
        ? Math.max(0, Math.min(BUDGET_CONFIG.FRIENDS_PER_WINDOW, Math.floor(rawFriends)))
        : BUDGET_CONFIG.FRIENDS_PER_WINDOW;

      // Automatically refill if the 60s window elapsed between batches
      this.refillIfDue(now);
    } else {
      this.general = BUDGET_CONFIG.HTTP_PER_WINDOW;
      this.friends = BUDGET_CONFIG.FRIENDS_PER_WINDOW;
      this.windowStart = Date.now();
    }
  }

  toState(): SerializedBudgetState {
    this.refillIfDue();
    return {
      generalRemaining: this.general,
      friendRemaining: this.friends,
      windowStartedAt: this.windowStart,
    };
  }

  /** Refills both buckets if the window elapsed. Safe to call frequently. */
  private refillIfDue(now = Date.now()): void {
    const elapsed = now - this.windowStart;
    if (elapsed < BUDGET_CONFIG.REFILL_WINDOW_MS) return;
    const windows = Math.floor(elapsed / BUDGET_CONFIG.REFILL_WINDOW_MS);
    this.windowStart += windows * BUDGET_CONFIG.REFILL_WINDOW_MS;
    this.general = BUDGET_CONFIG.HTTP_PER_WINDOW;
    this.friends = BUDGET_CONFIG.FRIENDS_PER_WINDOW;
  }

  msUntilRefill(now = Date.now()): number {
    this.refillIfDue(now);
    return Math.max(0, this.windowStart + BUDGET_CONFIG.REFILL_WINDOW_MS - now);
  }

  snapshot(): BudgetSnapshot {
    const now = Date.now();
    this.refillIfDue(now);
    return {
      http: this.general,
      friends: this.friends,
      refreshSeconds: Math.ceil(this.msUntilRefill(now) / 1000),
    };
  }

  /** True when a token of this kind is available right now. */
  available(kind: BudgetKind): boolean {
    this.refillIfDue();
    return (kind === "friends" ? this.friends : this.general) > 0;
  }

  /**
   * Consumes one token, reporting how long the caller must wait first.
   * Returns 0 when a token was available immediately.
   */
  reserve(kind: BudgetKind): number {
    this.refillIfDue();
    const pool = kind === "friends" ? this.friends : this.general;
    if (pool > 0) {
      if (kind === "friends") this.friends -= 1;
      else this.general -= 1;
      return 0;
    }
    const waitMs = this.msUntilRefill();
    this.onWait?.({ kind, waitMs });
    return waitMs;
  }

  /** Force-consume after a wait has already been served. */
  consumeAfterWait(kind: BudgetKind): void {
    this.refillIfDue();
    if (kind === "friends") this.friends = Math.max(0, this.friends - 1);
    else this.general = Math.max(0, this.general - 1);
  }
}
