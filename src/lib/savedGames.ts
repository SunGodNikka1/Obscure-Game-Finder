import type { DiscoveredGame } from "@/lib/discovery/types";

/**
 * GLOBAL SAVED GAMES -- pure collection logic
 *
 * Saved Games (the ◆ marks) are a browser-level OGF collection, independent
 * of any crawl: they survive New / Merge / finite / ∞ crawls, Restore,
 * Discard, reload and pool replacement. `universeId` is the stable key and a
 * full `DiscoveredGame` snapshot is stored with each save so the Saved tab
 * renders normally even when the discovery pool that found the game is gone.
 *
 * This module holds the pure, unit-tested rules (dedupe, merge on
 * rediscovery, legacy migration). Persistence lives in
 * `persistence/savedGamesStore.ts`; React wiring in `useSavedGames.ts`.
 */

export interface SavedGameRecord {
  /** Stable key. */
  universeId: number;
  /** When the user first saved it. Never changes on rediscovery. */
  savedAt: number;
  /** When the stored snapshot was last refreshed from a discovery. */
  updatedAt: number;
  /** Snapshot used to render the Saved tab when the pool no longer has the game. */
  game: DiscoveredGame;
  /**
   * True when only the id is known (migrated from the pre-global sessionStorage
   * id list). The snapshot is a placeholder until the universe is seen again.
   */
  stub: boolean;
}

/** sessionStorage keys used by the previous, per-session implementation. */
export const LEGACY_SAVED_KEYS = ["ogf.savedGames", "ogf.highlighted"] as const;

/** Metadata fields that count as "fresher information" on rediscovery. */
const SNAPSHOT_FIELDS: ReadonlyArray<keyof DiscoveredGame> = [
  "universeKnown",
  "rootPlaceId",
  "name",
  "description",
  "creatorName",
  "creatorId",
  "creatorType",
  "playing",
  "visits",
  "favorites",
  "upVotes",
  "downVotes",
  "maxPlayers",
  "genre",
  "created",
  "updated",
  "thumbnailUrl",
  "playabilityStatus",
  "privacyType",
  "obscurity",
  "source",
];

/** Provenance fields: kept from the ORIGINAL save unless the record is a stub. */
const PROVENANCE_FIELDS: ReadonlyArray<keyof DiscoveredGame> = [
  "discoveredByUserId",
  "discoveredByUserName",
  "discoveryDepth",
  "discoveryPath",
  "discoveryReason",
];

function snapshotFingerprint(game: DiscoveredGame): string {
  return JSON.stringify(SNAPSHOT_FIELDS.map((field) => game[field] ?? null));
}

/** Placeholder record for a universe we only know the id of. */
export function stubSavedGame(universeId: number): DiscoveredGame {
  return {
    universeId,
    universeKnown: universeId > 0,
    rootPlaceId: null,
    name: `Universe ${universeId}`,
    description: null,
    creatorName: null,
    creatorId: null,
    creatorType: null,
    playing: null,
    visits: null,
    favorites: null,
    upVotes: null,
    downVotes: null,
    maxPlayers: null,
    genre: null,
    created: null,
    updated: null,
    thumbnailUrl: null,
    playabilityStatus: null,
    privacyType: null,
    discoveredByUserId: null,
    discoveredByUserName: null,
    discoveryDepth: 0,
    discoveryPath: [],
    discoveryReason: "import",
    obscurity: null,
    source: "roblox",
  };
}

/** A brand-new save. */
export function makeSavedRecord(game: DiscoveredGame, now: number = Date.now()): SavedGameRecord {
  return { universeId: game.universeId, savedAt: now, updatedAt: now, game: { ...game }, stub: false };
}

/**
 * Merge a freshly discovered record into an existing save. Returns the
 * updated record, or `null` when nothing material changed (so callers can
 * skip a write). `savedAt` is always preserved; provenance is preserved
 * unless the existing record was a stub.
 */
export function mergeRediscovered(
  existing: SavedGameRecord,
  fresh: DiscoveredGame,
  now: number = Date.now(),
): SavedGameRecord | null {
  if (fresh.universeId !== existing.universeId) return null;
  if (!existing.stub && snapshotFingerprint(existing.game) === snapshotFingerprint(fresh)) return null;

  const merged: DiscoveredGame = { ...fresh };
  if (!existing.stub) {
    for (const field of PROVENANCE_FIELDS) {
      (merged as unknown as Record<string, unknown>)[field] = existing.game[field];
    }
  }
  return { universeId: existing.universeId, savedAt: existing.savedAt, updatedAt: now, game: merged, stub: false };
}

/**
 * Apply every fresher discovered record to the collection. Pure: returns the
 * records that changed (to be written) without touching the input map.
 */
export function reconcileSaved(
  records: ReadonlyMap<number, SavedGameRecord>,
  discovered: ReadonlyArray<DiscoveredGame>,
  now: number = Date.now(),
): SavedGameRecord[] {
  const changed: SavedGameRecord[] = [];
  const seen = new Set<number>();
  for (const game of discovered) {
    if (seen.has(game.universeId)) continue;
    seen.add(game.universeId);
    const existing = records.get(game.universeId);
    if (!existing) continue;
    const merged = mergeRediscovered(existing, game, now);
    if (merged) changed.push(merged);
  }
  return changed;
}

/** Parse the id list the previous implementation kept in sessionStorage. */
export function parseLegacySavedIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.filter((value): value is number => typeof value === "number" && Number.isFinite(value))));
  } catch {
    return [];
  }
}

/**
 * Plan the one-way import of legacy ids into the global collection.
 * Idempotent: ids already saved are skipped, duplicates collapse, nothing is
 * removed. Metadata is taken from `lookup` when the universe is currently
 * known; otherwise a stub is created and filled in on rediscovery.
 */
export function planLegacyImport(
  records: ReadonlyMap<number, SavedGameRecord>,
  legacyIds: ReadonlyArray<number>,
  lookup: (universeId: number) => DiscoveredGame | undefined,
  now: number = Date.now(),
): SavedGameRecord[] {
  const planned: SavedGameRecord[] = [];
  const seen = new Set<number>();
  for (const universeId of legacyIds) {
    if (seen.has(universeId) || records.has(universeId)) continue;
    seen.add(universeId);
    const known = lookup(universeId);
    planned.push(
      known
        ? makeSavedRecord(known, now)
        : { universeId, savedAt: now, updatedAt: now, game: stubSavedGame(universeId), stub: true },
    );
  }
  return planned;
}

/** Saved order: oldest save first (stable, like discovery order for the pool). */
export function sortSavedRecords(records: Iterable<SavedGameRecord>): SavedGameRecord[] {
  return Array.from(records).sort((a, b) => a.savedAt - b.savedAt || a.universeId - b.universeId);
}
