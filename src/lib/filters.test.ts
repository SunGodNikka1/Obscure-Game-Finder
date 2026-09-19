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
