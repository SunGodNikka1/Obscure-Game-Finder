import { describe, expect, it } from "vitest";
import { buildDemoGames } from "./demoData";
import {
  makeSavedRecord,
  mergeRediscovered,
  parseLegacySavedIds,
  planLegacyImport,
  reconcileSaved,
  sortSavedRecords,
  stubSavedGame,
  type SavedGameRecord,
} from "./savedGames";

const games = buildDemoGames();
const asMap = (records: SavedGameRecord[]) => new Map(records.map((r) => [r.universeId, r]));

describe("saving", () => {
  it("makes a record keyed by universeId with a full snapshot", () => {
    const record = makeSavedRecord(games[0], 1_000);
    expect(record.universeId).toBe(games[0].universeId);
    expect(record.savedAt).toBe(1_000);
    expect(record.stub).toBe(false);
    expect(record.game).toEqual(games[0]);
    expect(record.game).not.toBe(games[0]); // snapshot, not a shared reference
  });

  it("the same universe cannot exist twice: a Map keyed by universeId collapses repeats", () => {
    const map = asMap([makeSavedRecord(games[0], 1_000)]);
    const again = makeSavedRecord(games[0], 2_000);
    // the store is keyed by universeId, so the collection layer never grows
    const next = new Map(map);
    if (!next.has(again.universeId)) next.set(again.universeId, again);
    expect(next.size).toBe(1);
    expect(next.get(games[0].universeId)?.savedAt).toBe(1_000); // original save kept
  });
});

describe("rediscovery merge", () => {
  it("refreshes metadata, keeps savedAt and the original provenance, stays saved", () => {
    const existing = makeSavedRecord(games[0], 1_000);
    const fresh = { ...games[0], visits: 999_999, playing: 3, name: "Renamed", discoveredByUserName: "someoneElse", discoveryDepth: 4 };
    const merged = mergeRediscovered(existing, fresh, 5_000);
    expect(merged).not.toBeNull();
    expect(merged!.savedAt).toBe(1_000);
    expect(merged!.updatedAt).toBe(5_000);
    expect(merged!.game.visits).toBe(999_999);
    expect(merged!.game.name).toBe("Renamed");
    // provenance of the ORIGINAL save is kept
    expect(merged!.game.discoveredByUserName).toBe(games[0].discoveredByUserName);
    expect(merged!.game.discoveryDepth).toBe(games[0].discoveryDepth);
    expect(merged!.stub).toBe(false);
  });

  it("returns null when nothing material changed (no write needed)", () => {
    const existing = makeSavedRecord(games[0], 1_000);
    expect(mergeRediscovered(existing, { ...games[0] }, 5_000)).toBeNull();
    // provenance-only differences are not a change either
    expect(mergeRediscovered(existing, { ...games[0], discoveryDepth: 9 }, 5_000)).toBeNull();
  });

  it("ignores a record for a different universe", () => {
    expect(mergeRediscovered(makeSavedRecord(games[0]), games[1])).toBeNull();
  });

  it("a migrated stub takes everything, including provenance, from the first rediscovery", () => {
    const stub: SavedGameRecord = { universeId: games[2].universeId, savedAt: 1, updatedAt: 1, game: stubSavedGame(games[2].universeId), stub: true };
    const merged = mergeRediscovered(stub, games[2], 7);
    expect(merged!.stub).toBe(false);
    expect(merged!.game).toEqual(games[2]);
    expect(merged!.savedAt).toBe(1);
  });

  it("reconcileSaved updates only saved universes that changed, without duplicates", () => {
    const records = asMap([makeSavedRecord(games[0], 1), makeSavedRecord(games[1], 2)]);
    const pool = [
      { ...games[0], visits: 42 }, // changed
      { ...games[0], visits: 42 }, // duplicate entry in the source
      games[1], // unchanged
      games[3], // not saved
    ];
    const changed = reconcileSaved(records, pool, 9);
    expect(changed.map((r) => r.universeId)).toEqual([games[0].universeId]);
    expect(changed[0].game.visits).toBe(42);
    expect(records.size).toBe(2); // pure: input untouched
  });
});

describe("legacy migration", () => {
  it("parses the sessionStorage id list defensively", () => {
    expect(parseLegacySavedIds(JSON.stringify([1, 2, 2, "x", null, 3]))).toEqual([1, 2, 3]);
    expect(parseLegacySavedIds("not json")).toEqual([]);
    expect(parseLegacySavedIds(null)).toEqual([]);
    expect(parseLegacySavedIds(JSON.stringify({ a: 1 }))).toEqual([]);
  });

  it("imports unknown ids as stubs and known ids with full metadata, skipping already-saved ones", () => {
    const records = asMap([makeSavedRecord(games[0], 1)]);
    const lookup = (id: number) => games.find((g) => g.universeId === id);
    const planned = planLegacyImport(records, [games[0].universeId, games[1].universeId, 424242], lookup, 5);
    expect(planned.map((r) => r.universeId)).toEqual([games[1].universeId, 424242]);
    expect(planned[0].stub).toBe(false);
    expect(planned[0].game).toEqual(games[1]);
    expect(planned[1].stub).toBe(true);
    expect(planned[1].game.name).toBe("Universe 424242");
  });

  it("is idempotent: running the import again plans nothing and loses nothing", () => {
    const records = asMap([makeSavedRecord(games[0], 1)]);
    const legacy = [games[0].universeId, games[1].universeId, games[1].universeId, 424242];
    const first = planLegacyImport(records, legacy, () => undefined, 5);
    expect(first).toHaveLength(2); // duplicates collapse
    const after = new Map(records);
    for (const r of first) after.set(r.universeId, r);
    const second = planLegacyImport(after, legacy, () => undefined, 6);
    expect(second).toHaveLength(0);
    expect(after.size).toBe(3);
    expect(after.get(games[0].universeId)?.savedAt).toBe(1); // existing global save untouched
  });
});

describe("ordering", () => {
  it("lists saves oldest-first, stable on ties", () => {
    const sorted = sortSavedRecords([makeSavedRecord(games[2], 30), makeSavedRecord(games[0], 10), makeSavedRecord(games[1], 10)]);
    expect(sorted.map((r) => r.savedAt)).toEqual([10, 10, 30]);
    expect(sorted[0].universeId).toBeLessThan(sorted[1].universeId);
  });
});
