import type { RobloxClient } from "./client";
import { isValidRobloxId } from "./users";
import type { RobloxPagedResponse, RobloxUserGameEntry } from "./types";

/**
 * GET games.roblox.com/v2/users/{userId}/favorite/games
 *
 * Publicly favourited experiences. Users can hide this list; when they do the
 * endpoint answers 403 and the discovery engine records it as "unavailable".
 */
/**
 * Single page of favourite experiences, returning the continuation cursor.
 * Used by Continuous ∞ mode for resumable exhaustion of the favourites list.
 */
export async function fetchUserFavoriteGamesPage(
  client: RobloxClient,
  userId: number,
  cursor?: string | null,
): Promise<{ items: RobloxUserGameEntry[]; nextCursor: string | null }> {
  const payload = await client.request<RobloxPagedResponse<RobloxUserGameEntry>>({
    host: "games",
    path: `/v2/users/${userId}/favorite/games`,
    query: { limit: 50, cursor: cursor ?? undefined },
    label: `favourite experiences page of user ${userId}`,
  });
  return {
    items: (payload.data ?? []).filter((entry) => isValidRobloxId(entry.id)),
    nextCursor: payload.nextPageCursor ?? null,
  };
}

export async function listUserFavoriteGames(
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
      path: `/v2/users/${userId}/favorite/games`,
      query: { limit: pageSize, cursor },
      label: `favourite experiences of user ${userId}`,
    });
    for (const entry of payload.data ?? []) {
      if (isValidRobloxId(entry.id)) games.push(entry);
    }
    if (!payload.nextPageCursor) break;
    cursor = payload.nextPageCursor;
  }
  return games;
}
