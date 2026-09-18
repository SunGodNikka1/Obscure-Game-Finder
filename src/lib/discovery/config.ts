/**
 * Crawler safety limits. These are deliberately conservative: the crawler must
 * never become an uncontrolled recursive scraper of Roblox.
 *
 * To extend scan depth, raise MAX_DEPTH and (usually) MAX_USERS. Everything
 * else in the engine is driven from these constants.
 */
export const DISCOVERY_LIMITS = {
  /** Hard ceiling on friend-graph hops for finite scans. Depth 0, 1, 2, or 3. */
  MAX_DEPTH: 3,
  /** Hard ceiling on how many users are ever scanned in one finite run. */
  MAX_USERS: 100,
  /** Hard ceiling on discovered experiences in one finite run. */
  MAX_GAMES: 1000,
  /** Friends enqueued per scanned user in finite scans (keeps finite fan-out sane). */
  MAX_FRIENDS_PER_USER: 12,
  /** Pages (x50) of created experiences fetched per user. */
  CREATED_PAGES: 2,
  /** Pages (x50) of favourite experiences fetched per user. */
  FAVORITE_PAGES: 2,
  /** Pages (x50) of public place inventory fetched per user. */
  INVENTORY_PAGES: 1,
  /**
   * Inventory places resolved to universes per user. Each resolution costs one
   * Roblox request (the batched place-details endpoint requires auth), so this
   * is the main cost control for inventory discovery.
   */
  INVENTORY_MAX_RESOLVE_PER_USER: 20,
  /** Whole-scan wall clock budget for finite scans. */
  SCAN_BUDGET_MS: 110_000,
  /** Polite delay between scanned users. */
  USER_DELAY_MS: 120,
} as const;

/**
 * Continuous ∞ mode configuration.
 *
 * Continuous mode runs as a sequential, resumable series of bounded batches.
 * Limits here apply PER BATCH, never across the lifetime of the continuous crawl.
 */
export const CONTINUOUS_CONFIG = {
  /** Users processed per continuous batch (keeps batch time ~30-50s). */
  BATCH_USERS: 8,
  /** Hard wall-clock timeout for a single batch request. */
  BATCH_TIME_MS: 48_000,
  /** Polite delay between users in a batch. */
  USER_DELAY_MS: 120,
  /** Pause between consecutive batches on the client. */
  INTER_BATCH_DELAY_MS: 350,

  /*
   * RESUMABLE PER-USER SOURCE WORK
   *
   * Continuous mode must be able to exhaust every public page for a user
   * without making any single batch unbounded. Each visit to a user performs
   * at most this much work per source and returns continuation cursors; the
   * client re-queues the user until all sources report `done`.
   *
   * These are per-VISIT limits, never lifetime limits.
   */
  /** Pages of created experiences fetched per user visit. */
  CREATED_PAGES_PER_VISIT: 1,
  /** Pages of favourite experiences fetched per user visit. */
  FAVORITES_PAGES_PER_VISIT: 1,
  /** Pages of place inventory fetched per user visit. */
  INVENTORY_PAGES_PER_VISIT: 1,
  /** Inventory places resolved to universes per user visit. */
  PLACES_RESOLVED_PER_VISIT: 15,
  /**
   * Safety ceiling on queued-but-unresolved inventory places per user, so a
   * pathological account cannot grow the checkpoint without bound. This is a
   * BACKPRESSURE threshold, not a drop cap: when the queue cannot absorb a
   * whole page the next page is simply not fetched until the resolver has
   * drained room (see discovery/inventoryPolicy.ts). No returned id is lost.
   */
  MAX_PENDING_PLACES_PER_USER: 400,

  /*
   * BATCH RETRY / PAUSE POLICY
   *
   * A failed batch is retried with backoff. After MAX_BATCH_ATTEMPTS
   * consecutive failures the crawl PAUSES with the frontier preserved.
   */
  MAX_BATCH_ATTEMPTS: 3,
  RETRY_BASE_DELAY_MS: 2_000,
  RETRY_MAX_DELAY_MS: 15_000,

  /** Bounded discovery-path tail sent to the server (full path lives client-side). */
  PATH_TAIL_LENGTH: 6,
} as const;

export function clampDepth(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, Math.min(DISCOVERY_LIMITS.MAX_DEPTH, Math.floor(parsed)));
}
