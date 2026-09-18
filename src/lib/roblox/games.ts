import type { RobloxClient } from "./client";
import { isValidRobloxId } from "./users";
import type {
  RobloxGameDetail,
  RobloxGameVotes,
  RobloxPagedResponse,
  RobloxThumbnailEntry,
  RobloxUserGameEntry,
} from "./types";

const DETAIL_CHUNK = 50;
const THUMB_CHUNK = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * GET games.roblox.com/v2/users/{userId}/games
 * Experiences *created* by a user. Public, no auth required.
 */
export async function listUserCreatedGames(
  client: RobloxClient,
  userId: number,
  options: { maxPages?: number; pageSize?: 10 | 25 | 50 } = {},
): Promise<RobloxUserGameEntry[]> {
  const maxPages = options.maxPages ?? 2;
  const pageSize = options.pageSize ?? 50;
  const games: RobloxUserGameEntry[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const payload = await client.request<RobloxPagedResponse<RobloxUserGameEntry>>({
      host: "games",
      path: `/v2/users/${userId}/games`,
      query: { accessFilter: "Public", limit: pageSize, sortOrder: "Asc", cursor },
      label: `created experiences of user ${userId}`,
    });
    for (const entry of payload.data ?? []) {
      if (isValidRobloxId(entry.id)) games.push(entry);
    }
    if (!payload.nextPageCursor) break;
    cursor = payload.nextPageCursor;
  }
  return games;
}

/**
 * Single page of created experiences, returning the continuation cursor.
 * Used by Continuous ∞ mode so a user's created list can be exhausted across
 * multiple bounded visits instead of being truncated at a page cap.
 */
export async function fetchUserCreatedGamesPage(
  client: RobloxClient,
  userId: number,
  cursor?: string | null,
): Promise<{ items: RobloxUserGameEntry[]; nextCursor: string | null }> {
  const payload = await client.request<RobloxPagedResponse<RobloxUserGameEntry>>({
    host: "games",
    path: `/v2/users/${userId}/games`,
    query: { accessFilter: "Public", limit: 50, sortOrder: "Asc", cursor: cursor ?? undefined },
    label: `created experiences page of user ${userId}`,
  });
  return {
    items: (payload.data ?? []).filter((entry) => isValidRobloxId(entry.id)),
    nextCursor: payload.nextPageCursor ?? null,
  };
}

/** GET games.roblox.com/v1/games?universeIds= (batched, 50 per request) */
export async function getGameDetails(
  client: RobloxClient,
  universeIds: number[],
): Promise<Map<number, RobloxGameDetail>> {
  const out = new Map<number, RobloxGameDetail>();
  const ids = universeIds.filter(isValidRobloxId);
  for (const group of chunk(ids, DETAIL_CHUNK)) {
    const payload = await client.request<{ data?: RobloxGameDetail[] }>({
      host: "games",
      path: "/v1/games",
      query: { universeIds: group.join(",") },
      label: `metadata for ${group.length} experiences`,
    });
    for (const detail of payload.data ?? []) {
      if (isValidRobloxId(detail.id)) out.set(detail.id, detail);
    }
  }
  return out;
}

/** GET games.roblox.com/v1/games/votes?universeIds= */
export async function getGameVotes(
  client: RobloxClient,
  universeIds: number[],
): Promise<Map<number, RobloxGameVotes>> {
  const out = new Map<number, RobloxGameVotes>();
  const ids = universeIds.filter(isValidRobloxId);
  for (const group of chunk(ids, DETAIL_CHUNK)) {
    try {
      const payload = await client.request<{ data?: RobloxGameVotes[] }>({
        host: "games",
        path: "/v1/games/votes",
        query: { universeIds: group.join(",") },
        label: `votes for ${group.length} experiences`,
      });
      for (const votes of payload.data ?? []) {
        if (isValidRobloxId(votes.id)) out.set(votes.id, votes);
      }
    } catch {
      // Votes are optional enrichment.
    }
  }
  return out;
}

/** GET thumbnails.roblox.com/v1/games/multiget/thumbnails */
export async function getGameThumbnails(
  client: RobloxClient,
  universeIds: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = universeIds.filter(isValidRobloxId);
  for (const group of chunk(ids, THUMB_CHUNK)) {
    try {
      const payload = await client.request<{ data?: RobloxThumbnailEntry[] }>({
        host: "thumbnails",
        path: "/v1/games/multiget/thumbnails",
        query: {
          universeIds: group.join(","),
          size: "480x270",
          format: "Png",
          countPerUniverse: 1,
          isCircular: false,
        },
        label: `thumbnails for ${group.length} experiences`,
      });
      for (const entry of payload.data ?? []) {
        const thumb = entry.thumbnails?.[0];
        if (thumb?.imageUrl && thumb.state === "Completed") {
          out.set(entry.universeId, thumb.imageUrl);
        }
      }
    } catch {
      // Thumbnails are cosmetic.
    }
  }
  return out;
}

/** GET apis.roblox.com/universes/v1/places/{placeId}/universe */
export async function resolvePlaceToUniverse(
  client: RobloxClient,
  placeId: number,
): Promise<number | null> {
  if (!isValidRobloxId(placeId)) return null;
  const payload = await client.request<{ universeId: number | null }>({
    host: "apis",
    path: `/universes/v1/places/${placeId}/universe`,
    label: `resolve place ${placeId}`,
  });
  return isValidRobloxId(payload.universeId) ? payload.universeId : null;
}
