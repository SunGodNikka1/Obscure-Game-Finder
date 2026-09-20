import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { buildDemoGames } from "@/lib/demoData";
import { makeSavedRecord } from "@/lib/savedGames";
import { clearCrawl, loadCrawl, saveCrawl, type PersistedCrawl } from "./crawlStore";
import { deleteSavedGame, loadSavedGames, putSavedGames } from "./savedGamesStore";

/**
 * Runs the real store code against a real (in-memory) IndexedDB. Every
 * `load*` opens the database afresh, which is exactly what a reload does.
 */
const games = buildDemoGames();

function fakeCheckpoint(): PersistedCrawl {
  return {
    version: 1,
    savedAt: 1,
    username: "someone",
    target: null,
    sources: { includeCreated: true, includeFavorites: true, includeInventory: true },
    frontier: [{ userId: 1, username: "a", depth: 1 }],
    seenUserIds: [1],
    completedUserIds: [],
    parentMap: [],
    budgetState: null,
    maxDepthReached: 1,
    batchNumber: 1,
    cumulative: { usersScanned: 1, friendsFound: 0, requestsMade: 0, playable: 0, closed: 0 },
    games: [games[0]],
  };
}

beforeEach(() => {
  // a brand-new browser profile for every test
  globalThis.indexedDB = new IDBFactory();
});

describe("global Saved Games store", () => {
  it("1. a saved game survives a reload (fresh open of the database)", async () => {
    expect(await putSavedGames([makeSavedRecord(games[0], 1)])).toBe(true);
    const afterReload = await loadSavedGames();
    expect(afterReload?.map((r) => r.universeId)).toEqual([games[0].universeId]);
    expect(afterReload?.[0].game.name).toBe(games[0].name);
  });

  it("2/3. saved games are untouched by saving, replacing and discarding a crawl checkpoint", async () => {
    await putSavedGames([makeSavedRecord(games[0], 1), makeSavedRecord(games[1], 2)]);
    await saveCrawl(fakeCheckpoint()); // new crawl checkpoint written
    await saveCrawl({ ...fakeCheckpoint(), username: "someone-else", games: [] }); // replaced by a different user's crawl
    await clearCrawl(); // discarded
    expect(await loadCrawl()).toBeNull();
    expect((await loadSavedGames())?.map((r) => r.universeId).sort()).toEqual([games[0].universeId, games[1].universeId].sort());
  });

  it("4. the collection is keyed by universe only: nothing about it depends on a username", async () => {
    await putSavedGames([makeSavedRecord(games[0], 1)]);
    const rows = await loadSavedGames();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/username/);
  });

  it("5. putting the same universe twice keeps one record", async () => {
    await putSavedGames([makeSavedRecord(games[0], 1)]);
    await putSavedGames([makeSavedRecord(games[0], 2)]);
    const rows = await loadSavedGames();
    expect(rows).toHaveLength(1);
  });

  it("6. a refreshed snapshot overwrites in place (rediscovery) and keeps the save", async () => {
    const original = makeSavedRecord(games[0], 1);
    await putSavedGames([original]);
    await putSavedGames([{ ...original, updatedAt: 9, game: { ...original.game, visits: 12345 } }]);
    const rows = await loadSavedGames();
    expect(rows).toHaveLength(1);
    expect(rows?.[0].savedAt).toBe(1);
    expect(rows?.[0].game.visits).toBe(12345);
  });

  it("unsaving removes only that record", async () => {
    await putSavedGames([makeSavedRecord(games[0], 1), makeSavedRecord(games[1], 2)]);
    expect(await deleteSavedGame(games[0].universeId)).toBe(true);
    expect((await loadSavedGames())?.map((r) => r.universeId)).toEqual([games[1].universeId]);
    expect(await deleteSavedGame(999_999)).toBe(true); // deleting a non-existent id is not an error
  });

  it("12. migration writes are idempotent at the store level (re-running never duplicates)", async () => {
    const batch = [makeSavedRecord(games[0], 1), makeSavedRecord(games[1], 1)];
    await putSavedGames(batch);
    await putSavedGames(batch);
    await putSavedGames(batch);
    expect(await loadSavedGames()).toHaveLength(2);
  });

  it("fails soft when IndexedDB is unavailable", async () => {
    // @ts-expect-error simulate a browser without IndexedDB
    globalThis.indexedDB = undefined;
    expect(await loadSavedGames()).toBeNull();
    expect(await putSavedGames([makeSavedRecord(games[0], 1)])).toBe(false);
    expect(await deleteSavedGame(1)).toBe(false);
  });
});
