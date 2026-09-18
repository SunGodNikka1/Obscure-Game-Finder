/**
 * Types shared by the server-side discovery engine and the client UI.
 * These are transport types: they are serialised as NDJSON over /api/scan.
 */

export type DiscoveryReason = "created" | "favorite" | "inventory" | "import" | "demo";

/**
 * Identity for a place whose universe id could not be resolved.
 *
 * Such records are still valuable archaeology (ancient or broken places often
 * no longer expose a universe), so instead of discarding them we key them by a
 * synthetic NEGATIVE id derived from the place id. This keeps every existing
 * `Set<number>` / `Map<number, …>` (selection, highlight, dedupe) working
 * unchanged, and `universeKnown: false` tells the UI to render "--" for the
 * universe id rather than showing the synthetic value.
 */
export function placeOnlyKey(placeId: number): number {
  return -Math.abs(placeId);
}

export interface DiscoveredGame {
  /** Real Roblox universe id, or `placeOnlyKey(placeId)` when unresolved. */
  universeId: number;
  /** False when `universeId` is the synthetic place-only key. */
  universeKnown: boolean;
  rootPlaceId: number | null;
  name: string;
  description: string | null;
  creatorName: string | null;
  creatorId: number | null;
  creatorType: string | null;

  /** Roblox returns nulls for restricted experiences -- never fabricate. */
  playing: number | null;
  visits: number | null;
  favorites: number | null;
  upVotes: number | null;
  downVotes: number | null;
  maxPlayers: number | null;
  genre: string | null;

  created: string | null;
  updated: string | null;
  thumbnailUrl: string | null;

  /**
   * Raw `playabilityStatus` from Roblox, or null when unavailable.
   * Interpreted via `classifyPlayability` -- never stored pre-digested so the
   * client and server can never disagree about what a status means.
   */
  playabilityStatus: string | null;

  /** Why / how this experience entered the result set. */
  discoveredByUserId: number | null;
  discoveredByUserName: string | null;
  discoveryDepth: number;
  discoveryPath: string[];
  discoveryReason: DiscoveryReason;

  /** App-generated heuristic, 0-100. Not a Roblox metric. */
  obscurity: number | null;

  /** `demo` entries are synthetic and always badged in the UI. */
  source: "roblox" | "demo";
}

export type LogLevel = "info" | "ok" | "warn" | "error" | "system";

export interface ProcessLogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  message: string;
}

export interface ScanStats {
  /**
   * REMAINING general Roblox request budget in the current window.
   * (Crawler-managed safety budget, not a Roblox-granted quota -- see
   * `src/lib/roblox/budget.ts`.) This is what the UI labels `HTTP:`.
   */
  http: number;
  /** REMAINING friend-list request budget in the current window. */
  friends: number;
  /** Seconds until the budget window refills. UI labels this `Refresh:`. */
  refreshSeconds: number;
  /** Debug/internal: total requests actually performed this scan. */
  requestsMade: number;
  /** Debug/internal: friend records seen (was previously the `Friends:` value). */
  friendsFound: number;
  usersScanned: number;
  usersQueued: number;
  games: number;
  /** Experiences a signed-in account can currently launch. */
  playable: number;
  /** Experiences Roblox currently refuses to launch (maturity/age/private/…). */
  closed: number;
  failures: number;
  rateLimited: number;
  /** Seconds the engine is currently waiting before a retry (0 when running). */
  waitingSeconds: number;
}

/**
 * Resumable per-source work for one user.
 *
 * Continuous ∞ mode must eventually exhaust every publicly available page for a
 * user while keeping each batch bounded. Rather than fetching N pages and
 * silently dropping the rest, the server does a small, fixed amount of work per
 * source per visit and hands the continuation cursors back to the client, which
 * re-queues the user until every source reports `done`.
 *
 * `undefined` cursor = not started yet. `done: true` = source fully exhausted.
 */
export interface UserSourceWork {
  createdCursor?: string | null;
  createdDone?: boolean;
  favoritesCursor?: string | null;
  favoritesDone?: boolean;
  inventoryCursor?: string | null;
  inventoryDone?: boolean;
  /** Inventory place ids discovered but not yet resolved to universe ids. */
  pendingPlaceIds?: number[];
  /** Friend list is fetched exactly once per user. */
  friendsDone?: boolean;
}

export interface FrontierNode {
  userId: number;
  username: string;
  depth: number;
  /**
   * Predecessor in the friend graph. The client keeps the authoritative
   * parent map and reconstructs full discovery paths locally, so request
   * payloads never grow with crawl depth.
   */
  parentUserId?: number | null;
  /**
   * Bounded tail of the discovery path (last few usernames) used only for
   * server-side logging and for the provisional path on emitted games. The
   * client overwrites `discoveryPath` with the full reconstruction.
   */
  pathTail?: string[];
  /** Resumable source cursors; absent means "nothing done yet". */
  work?: UserSourceWork;
}

export interface DiscoveredFriendRef {
  id: number;
  name: string;
}

export interface UserFriendDiscovery {
  sourceUserId: number;
  friends: DiscoveredFriendRef[];
}

/** Per-node outcome so the client knows whether to re-queue for more work. */
export interface NodeWorkResult {
  userId: number;
  work: UserSourceWork;
  /** True when at least one source still has pages/places outstanding. */
  hasMoreWork: boolean;
}

export interface BatchCheckpoint {
  /**
   * Whether the batch completed its planned work without a fatal error.
   * A checkpoint is emitted even on failure (so partial progress is not lost),
   * therefore the client MUST branch on this flag, not on the mere existence
   * of a checkpoint.
   */
  ok: boolean;
  /** Present when `ok` is false. */
  reason?: string;
  /** Users whose planned work for THIS batch finished (may still have more work). */
  processedUserIds: number[];
  /** Continuation state per user visited in this batch. */
  nodeResults: NodeWorkResult[];
  discoveredFriends: UserFriendDiscovery[];
  budgetState: {
    generalRemaining: number;
    friendRemaining: number;
    windowStartedAt: number;
  };
  stats: ScanStats;
}

export type ScanEvent =
  | { type: "log"; ts: number; level: LogLevel; message: string }
  | { type: "stats"; ts: number; stats: ScanStats }
  | { type: "target"; ts: number; userId: number; username: string; displayName: string }
  /** The player the crawler is scanning right now (pinned in Processes). */
  | { type: "scanning"; ts: number; userId: number; username: string; depth: number }
  | { type: "games"; ts: number; games: DiscoveredGame[] }
  | { type: "done"; ts: number; ok: boolean; message: string; stats: ScanStats }
  | { type: "batchCheckpoint"; ts: number; checkpoint: BatchCheckpoint };

export interface ScanRequestPayload {
  username: string;
  depth: number;
  includeFavorites: boolean;
  includeCreated: boolean;
  /** Public place-inventory discovery (original OGF source). */
  includeInventory: boolean;
}

export interface ContinuousBatchPayload {
  initialUsername?: string;
  nodes: FrontierNode[];
  includeInventory: boolean;
  includeFavorites: boolean;
  includeCreated: boolean;
  budgetState?: {
    generalRemaining: number;
    friendRemaining: number;
    windowStartedAt: number;
  } | null;
  knownUniverseIds?: number[];
}
