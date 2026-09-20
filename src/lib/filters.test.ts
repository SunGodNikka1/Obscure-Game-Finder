import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, SORT_OPTIONS, applyFilters } from "./filters";
import { buildDemoGames } from "./demoData";

const NONE: ReadonlySet<number> = new Set();
const ids = (games: ReturnType<typeof buildDemoGames>) => games.map((g) => g.universeId);

describe("sort: discovery order vs newest discovered first", () => {
  it("offers 'Newest discovered first' directly after 'Discovery order'", () => {
    const values = SORT_OPTIONS.map((o) => o.value);
    expect(values.indexOf("recentDiscovery")).toBe(values.indexOf("default") + 1);
    expect(SORT_OPTIONS.find((o) => o.value === "recentDiscovery")?.label).toBe("Newest discovered first");
  });

  it("'Discovery order' keeps first-found -> last-found", () => {
    const games = buildDemoGames();
    expect(ids(applyFilters(games, { ...DEFAULT_FILTERS, sort: "default" }, NONE))).toEqual(ids(games));
  });

  it("'Newest discovered first' is exactly the discovery order reversed", () => {
    const games = buildDemoGames();
    const out = applyFilters(games, { ...DEFAULT_FILTERS, sort: "recentDiscovery" }, NONE);
    expect(ids(out)).toEqual([...ids(games)].reverse());
    expect(out[0].universeId).toBe(games[games.length - 1].universeId);
    expect(out[out.length - 1].universeId).toBe(games[0].universeId);
  });

  it("does not mutate the input array and returns a new array", () => {
    const games = buildDemoGames();
    const before = ids(games);
    const out = applyFilters(games, { ...DEFAULT_FILTERS, sort: "recentDiscovery" }, NONE);
    expect(ids(games)).toEqual(before);
    expect(out).not.toBe(games);
  });

  it("a newly discovered game (appended) rises to the top", () => {
    const games = buildDemoGames();
    const grown = [...games, { ...games[0], universeId: 999_999_001, name: "just found" }];
    const out = applyFilters(grown, { ...DEFAULT_FILTERS, sort: "recentDiscovery" }, NONE);
    expect(out[0].universeId).toBe(999_999_001);
    expect(ids(out).slice(1)).toEqual([...ids(games)].reverse());
  });

  it("is a different ordering from 'Newest -> Oldest' (Roblox creation date)", () => {
    const games = buildDemoGames();
    const byDiscovery = ids(applyFilters(games, { ...DEFAULT_FILTERS, sort: "recentDiscovery" }, NONE));
    const byCreated = applyFilters(games, { ...DEFAULT_FILTERS, sort: "newest" }, NONE);
    const createdTs = byCreated.map((g) => Date.parse(g.created ?? ""));
    // creation-date sort really is by created date, descending
    expect(createdTs.every((t, i) => i === 0 || t <= createdTs[i - 1])).toBe(true);
    // and it is not simply the reversed discovery order for this fixture
    expect(ids(byCreated)).not.toEqual(byDiscovery);
  });

  it("still applies the active filters before reversing", () => {
    const games = buildDemoGames();
    const target = games[2];
    const out = applyFilters(games, { ...DEFAULT_FILTERS, sort: "recentDiscovery", content: target.name }, NONE);
    expect(ids(out)).toEqual([target.universeId]);
  });
});

describe("hide saved games (display-only filter)", () => {
  const games = buildDemoGames();
  const savedIds: ReadonlySet<number> = new Set([games[1].universeId, games[4].universeId]);

  it("7. OFF leaves saved games in the list exactly as before", () => {
    const out = applyFilters(games, { ...DEFAULT_FILTERS, hideSaved: false }, NONE, savedIds);
    expect(ids(out)).toEqual(ids(games));
  });

  it("8. ON removes only the saved universes, and only from the displayed list", () => {
    const out = applyFilters(games, { ...DEFAULT_FILTERS, hideSaved: true }, NONE, savedIds);
    expect(ids(out)).toEqual(ids(games).filter((id) => !savedIds.has(id)));
    expect(games).toHaveLength(6); // input untouched
    expect(ids(games)).toContain(games[1].universeId);
  });

  it("9/10. saving hides immediately; unsaving makes it eligible again", () => {
    const on = { ...DEFAULT_FILTERS, hideSaved: true };
    const before = ids(applyFilters(games, on, NONE, new Set()));
    expect(before).toContain(games[2].universeId);
    const afterSave = ids(applyFilters(games, on, NONE, new Set([games[2].universeId])));
    expect(afterSave).not.toContain(games[2].universeId);
    expect(afterSave).toHaveLength(before.length - 1);
    const afterUnsave = ids(applyFilters(games, on, NONE, new Set()));
    expect(afterUnsave).toEqual(before);
  });

  it("11. composes with every sort and the other filters", () => {
    for (const sort of ["default", "recentDiscovery", "oldest", "newest", "obscurity", "leastVisits", "name"] as const) {
      const withHide = ids(applyFilters(games, { ...DEFAULT_FILTERS, sort, hideSaved: true }, NONE, savedIds));
      const withoutHide = ids(applyFilters(games, { ...DEFAULT_FILTERS, sort, hideSaved: false }, NONE, savedIds));
      // same relative order as the unhidden list, minus the saved ones
      expect(withHide).toEqual(withoutHide.filter((id) => !savedIds.has(id)));
    }
    // content search + hide
    const target = games[1];
    expect(applyFilters(games, { ...DEFAULT_FILTERS, hideSaved: true, content: target.name }, NONE, savedIds)).toHaveLength(0);
    expect(applyFilters(games, { ...DEFAULT_FILTERS, hideSaved: false, content: target.name }, NONE, savedIds)).toHaveLength(1);
    // selected-only + hide: the intersection rule still applies
    const sel = new Set([games[1].universeId, games[0].universeId]);
    expect(ids(applyFilters(games, { ...DEFAULT_FILTERS, hideSaved: true, selectedOnly: true }, sel, savedIds))).toEqual([games[0].universeId]);
  });

  it("without a savedIds argument the flag is a no-op (nothing to hide)", () => {
    expect(ids(applyFilters(games, { ...DEFAULT_FILTERS, hideSaved: true }, NONE))).toEqual(ids(games));
  });
});
