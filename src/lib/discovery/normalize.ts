import { getGameDetails, getGameThumbnails, getGameVotes } from "@/lib/roblox/games";
import { getPlayabilityStatuses } from "@/lib/roblox/playability";
import type { RobloxClient } from "@/lib/roblox/client";
import type { RobloxGameDetail, RobloxGameVotes, RobloxUserGameEntry } from "@/lib/roblox/types";
import { computeObscurity } from "@/lib/obscurity";
import { placeOnlyKey, type DiscoveredGame, type DiscoveryReason } from "./types";

export interface DiscoveryMeta {
  discoveredByUserId: number | null;
  discoveredByUserName: string | null;
  discoveryDepth: number;
  discoveryPath: string[];
  discoveryReason: DiscoveryReason;
}

export interface FallbackGameInfo {
  name?: string | null;
  description?: string | null;
  rootPlaceId?: number | null;
  creatorId?: number | null;
  created?: string | null;
  updated?: string | null;
  visits?: number | null;
}

export function fallbackFromUserGameEntry(entry: RobloxUserGameEntry): FallbackGameInfo {
  return {
    name: entry.name,
    description: entry.description,
    rootPlaceId: entry.rootPlace?.id ?? null,
    creatorId: entry.creator?.id ?? null,
    created: entry.created ?? null,
    updated: entry.updated ?? null,
    visits: typeof entry.placeVisits === "number" ? entry.placeVisits : null,
  };
}

/**
 * Builds a DiscoveredGame for a real Roblox place whose universe could not be
 * resolved (ancient, broken or delisted places frequently behave this way).
 *
 * The place identity is genuine, so the discovery is preserved rather than
 * dropped. Every statistic Roblox did not give us stays `null` -- nothing is
 * invented -- and `universeKnown: false` makes the UI render "--" for the
 * universe id.
 */
export function buildPlaceOnlyGame(
  entry: { placeId: number; name: string | null; created: string | null },
  meta: DiscoveryMeta,
): DiscoveredGame {
  return {
    universeId: placeOnlyKey(entry.placeId),
    universeKnown: false,
    rootPlaceId: entry.placeId,
    name: entry.name?.trim() ? entry.name : "Unknown Experience",
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
    created: entry.created,
    updated: null,
    thumbnailUrl: null,
    playabilityStatus: null,
    discoveredByUserId: meta.discoveredByUserId,
    discoveredByUserName: meta.discoveredByUserName,
    discoveryDepth: meta.discoveryDepth,
    discoveryPath: meta.discoveryPath,
    discoveryReason: meta.discoveryReason,
    obscurity: null,
    source: "roblox",
  };
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/**
 * Turns a set of universe ids into fully normalised DiscoveredGame records by
 * combining /v1/games metadata, /v1/games/votes and the thumbnails service.
 * Missing values stay `null` -- statistics are never invented.
 */
export async function hydrateUniverses(
  client: RobloxClient,
  universeIds: number[],
  metaFor: (universeId: number) => DiscoveryMeta,
  options: {
    fallback?: Map<number, FallbackGameInfo>;
    maxDepth?: number;
    withVotes?: boolean;
    withThumbnails?: boolean;
    withPlayability?: boolean;
  } = {},
): Promise<DiscoveredGame[]> {
  const ids = Array.from(new Set(universeIds));
  if (ids.length === 0) return [];

  let details = new Map<number, RobloxGameDetail>();
  try {
    details = await getGameDetails(client, ids);
  } catch {
    // Metadata service unavailable -- we still emit fallback rows below.
  }

  const votes: Map<number, RobloxGameVotes> =
    options.withVotes === false ? new Map() : await getGameVotes(client, ids);
  const thumbs = options.withThumbnails === false ? new Map<number, string>() : await getGameThumbnails(client, ids);
  const playability =
    options.withPlayability === false ? new Map<number, string>() : await getPlayabilityStatuses(client, ids);

  const games: DiscoveredGame[] = [];
  for (const universeId of ids) {
    const detail = details.get(universeId);
    const fallback = options.fallback?.get(universeId);
    const restricted = detail?.isContentRestricted === true || detail?.id === 0;

    const name =
      (!restricted ? str(detail?.name) : null) ?? str(fallback?.name) ?? `Universe ${universeId}`;
    const meta = metaFor(universeId);

    const visits = (!restricted ? num(detail?.visits) : null) ?? num(fallback?.visits);
    const playing = !restricted ? num(detail?.playing) : null;
    const favorites = !restricted ? num(detail?.favoritedCount) : null;
    const updated = (!restricted ? str(detail?.updated) : null) ?? str(fallback?.updated);

    games.push({
      universeId,
      universeKnown: true,
      rootPlaceId: (!restricted ? num(detail?.rootPlaceId) : null) ?? num(fallback?.rootPlaceId),
      name,
      description: (!restricted ? str(detail?.description) : null) ?? str(fallback?.description),
      creatorName: !restricted ? str(detail?.creator?.name) : null,
      creatorId: (!restricted ? num(detail?.creator?.id) : null) ?? num(fallback?.creatorId),
      creatorType: !restricted ? str(detail?.creator?.type) : null,
      playing,
      visits,
      favorites,
      upVotes: num(votes.get(universeId)?.upVotes),
      downVotes: num(votes.get(universeId)?.downVotes),
      maxPlayers: !restricted ? num(detail?.maxPlayers) : null,
      genre: !restricted ? str(detail?.genre) : null,
      created: (!restricted ? str(detail?.created) : null) ?? str(fallback?.created),
      updated,
      thumbnailUrl: thumbs.get(universeId) ?? null,
      playabilityStatus: playability.get(universeId) ?? null,
      discoveredByUserId: meta.discoveredByUserId,
      discoveredByUserName: meta.discoveredByUserName,
      discoveryDepth: meta.discoveryDepth,
      discoveryPath: meta.discoveryPath,
      discoveryReason: meta.discoveryReason,
      obscurity: computeObscurity({
        visits,
        playing,
        favorites,
        updated,
        discoveryDepth: meta.discoveryDepth,
        maxDepth: options.maxDepth ?? 2,
      }),
      source: "roblox",
    });
  }
  return games;
}
