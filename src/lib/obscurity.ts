import type { DiscoveredGame } from "@/lib/discovery/types";

/**
 * OBSCURITY HEURISTIC (application-generated -- NOT a Roblox metric).
 *
 * Returns 0-100 where 100 is "almost nobody has ever seen this place".
 * The score is a weighted blend of five signals; each signal is normalised to
 * 0..1 and multiplied by its weight:
 *
 *   visits      40 pts  1 - log10(visits + 1) / 7      (10M visits -> 0)
 *   players     20 pts  1 - log10(playing + 1) / 4     (10k CCU    -> 0)
 *   favorites   20 pts  1 - log10(favorites + 1) / 5   (100k favs  -> 0)
 *   dormancy    12 pts  years since last update / 8    (8y stale   -> full)
 *   depth        8 pts  discoveryDepth / MAX_DEPTH     (deeper = more hidden)
 *
 * When Roblox does not return a statistic we skip that component and
 * re-normalise over the weights we actually have, so missing data never
 * silently inflates or deflates the score. If nothing at all is known the
 * function returns null and the UI renders "--".
 */

const WEIGHTS = {
  visits: 40,
  players: 20,
  favorites: 20,
  dormancy: 12,
  depth: 8,
} as const;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export interface ObscurityInput {
  visits: number | null;
  playing: number | null;
  favorites: number | null;
  updated: string | null;
  discoveryDepth: number;
  maxDepth?: number;
}

export function computeObscurity(input: ObscurityInput): number | null {
  let total = 0;
  let available = 0;

  if (typeof input.visits === "number") {
    total += WEIGHTS.visits * clamp01(1 - Math.log10(input.visits + 1) / 7);
    available += WEIGHTS.visits;
  }
  if (typeof input.playing === "number") {
    total += WEIGHTS.players * clamp01(1 - Math.log10(input.playing + 1) / 4);
    available += WEIGHTS.players;
  }
  if (typeof input.favorites === "number") {
    total += WEIGHTS.favorites * clamp01(1 - Math.log10(input.favorites + 1) / 5);
    available += WEIGHTS.favorites;
  }
  if (input.updated) {
    const updatedAt = Date.parse(input.updated);
    if (Number.isFinite(updatedAt)) {
      const years = (Date.now() - updatedAt) / (365.25 * 24 * 60 * 60 * 1000);
      total += WEIGHTS.dormancy * clamp01(years / 8);
      available += WEIGHTS.dormancy;
    }
  }

  const maxDepth = Math.max(1, input.maxDepth ?? 2);
  total += WEIGHTS.depth * clamp01(input.discoveryDepth / maxDepth);
  available += WEIGHTS.depth;

  if (available <= WEIGHTS.depth) return null; // depth alone tells us nothing
  return Math.round((total / available) * 100);
}

export function obscurityLabel(score: number | null): string {
  if (score === null) return "unknown";
  if (score >= 88) return "buried";
  if (score >= 74) return "forgotten";
  if (score >= 58) return "obscure";
  if (score >= 40) return "quiet";
  if (score >= 22) return "known";
  return "popular";
}

export function withObscurity(game: DiscoveredGame, maxDepth = 2): DiscoveredGame {
  return {
    ...game,
    obscurity: computeObscurity({
      visits: game.visits,
      playing: game.playing,
      favorites: game.favorites,
      updated: game.updated,
      discoveryDepth: game.discoveryDepth,
      maxDepth,
    }),
  };
}
