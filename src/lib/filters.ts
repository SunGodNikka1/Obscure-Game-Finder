import type { DiscoveredGame } from "@/lib/discovery/types";
import { classifyPlayability } from "@/lib/playability";

export type UserScope = "all" | "start" | "friends" | "deep";
/**
 * `open`    -> only experiences a signed-in account can actually launch
 * `blocked` -> everything Roblox currently refuses to launch
 * `unrated` -> specifically the maturity-questionnaire / age-recommendation closures
 * `unknown` -> Roblox returned no status
 */
export type PlayabilityFilter = "any" | "open" | "blocked" | "unrated" | "unknown";
export type QuickFilter = "none" | "zero" | "under10" | "under100" | "dormant" | "unknownStats";
export type SortMode =
  | "default"
  | "recentDiscovery"
  | "oldest"
  | "newest"
  | "obscurity"
  | "leastVisits"
  | "leastFavorites"
  | "deepest"
  | "mostPlayers"
  | "name";

export const SORT_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: "default", label: "Discovery order" },
  { value: "recentDiscovery", label: "Newest discovered first" },
  { value: "oldest", label: "Oldest → Newest" },
  { value: "newest", label: "Newest → Oldest" },
  { value: "obscurity", label: "Most obscure first" },
  { value: "leastVisits", label: "Least visits first" },
  { value: "leastFavorites", label: "Least favorites first" },
  { value: "deepest", label: "Deepest discovery first" },
  { value: "mostPlayers", label: "Most players first" },
  { value: "name", label: "Name (A → Z)" },
];

export interface FilterState {
  content: string;
  userScope: UserScope;
  genre: string;
  visitsMin: string;
  visitsMax: string;
  playersMin: string;
  playersMax: string;
  favoritesMin: string;
  favoritesMax: string;
  createdFrom: string;
  createdTo: string;
  quick: QuickFilter;
  sort: SortMode;
  selectedOnly: boolean;
  minObscurity: number;
  playability: PlayabilityFilter;
}

export const DEFAULT_FILTERS: FilterState = {
  content: "",
  userScope: "all",
  genre: "any",
  visitsMin: "",
  visitsMax: "",
  playersMin: "",
  playersMax: "",
  favoritesMin: "",
  favoritesMax: "",
  createdFrom: "",
  createdTo: "",
  quick: "none",
  sort: "default",
  selectedOnly: false,
  minObscurity: 0,
  playability: "any",
};

const toNumber = (raw: string): number | null => {
  if (!raw.trim()) return null;
  const parsed = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * ORIGINAL OGF SEMANTICS: "Setting a value to zero removes the limit, so any
 * game can be displayed (in a maximum value's case)."
 *
 * This applies ONLY to MAXIMUM-bound controls (Visits max, Players max,
 * Favorites max). A maximum of 0 means "no upper limit", matching the original:
 *
 *   Visits  250 - 0   -> visits >= 250, no ceiling
 *   Players   0 - 0   -> any player count
 *
 * Minimum fields keep their literal meaning: a minimum of 0 is a real lower
 * bound of zero (that is how "0 players only" style filtering stays possible),
 * and the `Created` date range is untouched because a zero date is meaningless.
 */
const toMaxNumber = (raw: string): number | null => {
  const parsed = toNumber(raw);
  if (parsed === null) return null;
  return parsed === 0 ? null : parsed;
};

const inRange = (value: number | null, min: number | null, max: number | null): boolean => {
  if (min === null && max === null) return true;
  if (value === null) return false; // unknown stats cannot satisfy a numeric bound
  if (min !== null && value < min) return false;
  if (max !== null && value > max) return false;
  return true;
};

export function collectGenres(games: DiscoveredGame[]): string[] {
  const set = new Set<string>();
  for (const game of games) {
    if (game.genre && game.genre.trim() && game.genre !== "All") set.add(game.genre);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export function applyFilters(
  games: DiscoveredGame[],
  filters: FilterState,
  selected: ReadonlySet<number>,
): DiscoveredGame[] {
  const needle = filters.content.trim().toLowerCase();
  const visitsMin = toNumber(filters.visitsMin);
  const visitsMax = toMaxNumber(filters.visitsMax);
  const playersMin = toNumber(filters.playersMin);
  const playersMax = toMaxNumber(filters.playersMax);
  const favoritesMin = toNumber(filters.favoritesMin);
  const favoritesMax = toMaxNumber(filters.favoritesMax);
  const createdFrom = filters.createdFrom ? Date.parse(filters.createdFrom) : null;
  const createdTo = filters.createdTo ? Date.parse(`${filters.createdTo}T23:59:59Z`) : null;
  const dormantCutoff = Date.now() - 3 * 365.25 * 24 * 60 * 60 * 1000;

  const filtered = games.filter((game) => {
    if (filters.selectedOnly && !selected.has(game.universeId)) return false;

    if (needle) {
      const haystack = [game.name, game.description ?? "", game.creatorName ?? "", game.discoveryPath.join(" ")]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    if (filters.userScope === "start" && game.discoveryDepth !== 0) return false;
    if (filters.userScope === "friends" && game.discoveryDepth !== 1) return false;
    if (filters.userScope === "deep" && game.discoveryDepth < 2) return false;

    if (filters.genre !== "any" && (game.genre ?? "") !== filters.genre) return false;

    if (!inRange(game.visits, visitsMin, visitsMax)) return false;
    if (!inRange(game.playing, playersMin, playersMax)) return false;
    if (!inRange(game.favorites, favoritesMin, favoritesMax)) return false;

    if (createdFrom !== null || createdTo !== null) {
      const created = game.created ? Date.parse(game.created) : NaN;
      if (!Number.isFinite(created)) return false;
      if (createdFrom !== null && created < createdFrom) return false;
      if (createdTo !== null && created > createdTo) return false;
    }

    switch (filters.quick) {
      case "zero":
        if (game.playing !== 0) return false;
        break;
      case "under10":
        if (game.playing === null || game.playing >= 10) return false;
        break;
      case "under100":
        if (game.playing === null || game.playing >= 100) return false;
        break;
      case "dormant": {
        const updated = game.updated ? Date.parse(game.updated) : NaN;
        if (!Number.isFinite(updated) || updated > dormantCutoff) return false;
        break;
      }
      case "unknownStats":
        if (game.visits !== null && game.playing !== null) return false;
        break;
      default:
        break;
    }

    if (filters.minObscurity > 0 && (game.obscurity ?? -1) < filters.minObscurity) return false;

    if (filters.playability !== "any") {
      const info = classifyPlayability(game.playabilityStatus);
      if (filters.playability === "open" && !info.open) return false;
      if (filters.playability === "blocked" && (info.open || info.state === "unknown")) return false;
      if (filters.playability === "unrated" && info.state !== "unrated") return false;
      if (filters.playability === "unknown" && info.state !== "unknown") return false;
    }

    return true;
  });

  if (filters.sort === "default") {
    return filtered;
  }

  // "Newest discovered first" is the discovery order reversed: the game OGF
  // found most recently comes first. This is about when the finder saw the
  // game, NOT the Roblox creation date ("newest" below). Reversed copy only --
  // the underlying games array and the crawl order are untouched.
  if (filters.sort === "recentDiscovery") {
    return [...filtered].reverse();
  }

  const parseDateTs = (value: string | null): number | null => {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  // Preserve discovery order as tiebreaker for stable sorting
  const indexed = filtered.map((game, index) => ({ game, index }));

  indexed.sort((itemA, itemB) => {
    const a = itemA.game;
    const b = itemB.game;
    let diff = 0;

    switch (filters.sort) {
      case "oldest": {
        const da = parseDateTs(a.created);
        const db = parseDateTs(b.created);
        // Missing/invalid dates ALWAYS sort last
        if (da === null && db === null) diff = 0;
        else if (da === null) diff = 1;
        else if (db === null) diff = -1;
        else diff = da - db;
        break;
      }
      case "newest": {
        const da = parseDateTs(a.created);
        const db = parseDateTs(b.created);
        // Missing/invalid dates ALWAYS sort last (even in newest-first)
        if (da === null && db === null) diff = 0;
        else if (da === null) diff = 1;
        else if (db === null) diff = -1;
        else diff = db - da;
        break;
      }
      case "obscurity": {
        const oa = a.obscurity;
        const ob = b.obscurity;
        if (oa === null && ob === null) diff = 0;
        else if (oa === null) diff = 1;
        else if (ob === null) diff = -1;
        else diff = ob - oa;
        break;
      }
      case "leastVisits": {
        const va = a.visits;
        const vb = b.visits;
        if (va === null && vb === null) diff = 0;
        else if (va === null) diff = 1;
        else if (vb === null) diff = -1;
        else diff = va - vb;
        break;
      }
      case "leastFavorites": {
        const fa = a.favorites;
        const fb = b.favorites;
        if (fa === null && fb === null) diff = 0;
        else if (fa === null) diff = 1;
        else if (fb === null) diff = -1;
        else diff = fa - fb;
        break;
      }
      case "deepest":
        diff = b.discoveryDepth - a.discoveryDepth;
        break;
      case "mostPlayers": {
        const pa = a.playing;
        const pb = b.playing;
        if (pa === null && pb === null) diff = 0;
        else if (pa === null) diff = 1;
        else if (pb === null) diff = -1;
        else diff = pb - pa;
        break;
      }
      case "name":
        diff = a.name.localeCompare(b.name);
        break;
      default:
        diff = 0;
        break;
    }

    // Stable sort tiebreaker: preserve initial discovery order
    return diff !== 0 ? diff : itemA.index - itemB.index;
  });

  return indexed.map((item) => item.game);
}

export function gameUrl(game: DiscoveredGame): string {
  const slug = game.name
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (game.rootPlaceId) {
    return `https://www.roblox.com/games/${game.rootPlaceId}${slug ? `/${slug}` : ""}`;
  }
  return `https://www.roblox.com/discover#/search/${encodeURIComponent(game.name)}`;
}
