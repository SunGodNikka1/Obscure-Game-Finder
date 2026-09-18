import type { RobloxClient } from "./client";
import { isValidRobloxId } from "./users";
import type { RobloxInventoryPlace, RobloxPagedResponse } from "./types";

/** Roblox asset type id for Place. */
export const ASSET_TYPE_PLACE = 9;

/**
 * GET inventory.roblox.com/v2/users/{userId}/inventory/9
 *
 * Public place inventory -- the third original OGF discovery source alongside
 * favourites and the friend graph. Verified working unauthenticated; it is a
 * genuinely rich vein of archaeology (a veteran account returns places from
 * 2007 that no longer appear anywhere else).
 *
 * Endpoint notes discovered while wiring this up:
 *  - `assetId` here is a PLACE id, not a universe id. Each one needs a separate
 *    `/universes/v1/places/{id}/universe` call; the batched
 *    `games/v1/games/multiget-place-details` alternative requires auth (401),
 *    so resolution is deliberately capped per user by the caller.
 *  - `assetName` IS returned even for places whose universe can no longer be
 *    resolved, which lets the engine preserve a named "broken" record instead
 *    of throwing the discovery away.
 *  - Users may hide their inventory: the endpoint answers 403 and callers must
 *    treat that as "inventory unavailable", not as a fatal error.
 *  - `can-view-inventory` is rate limited very aggressively (429 within a few
 *    calls), so we do NOT pre-check; we just attempt the read and handle 403.
 */
/**
 * Single page of the public place inventory, returning the continuation cursor.
 * Used by Continuous ∞ mode so a 150-place inventory is eventually exhausted
 * across visits instead of being truncated on the first visit.
 */
export async function fetchUserPlaceInventoryPage(
  client: RobloxClient,
  userId: number,
  cursor?: string | null,
): Promise<{ items: RobloxInventoryPlace[]; nextCursor: string | null }> {
  if (!isValidRobloxId(userId)) return { items: [], nextCursor: null };
  const payload = await client.request<RobloxPagedResponse<RobloxInventoryPlace>>({
    host: "inventory",
    path: `/v2/users/${userId}/inventory/${ASSET_TYPE_PLACE}`,
    query: { limit: 50, sortOrder: "Asc", cursor: cursor ?? undefined },
    label: `place inventory page of user ${userId}`,
  });
  return {
    items: (payload.data ?? []).filter((entry) => isValidRobloxId(entry.assetId)),
    nextCursor: payload.nextPageCursor ?? null,
  };
}

export async function listUserPlaceInventory(
  client: RobloxClient,
  userId: number,
  options: { maxPages?: number; pageSize?: 10 | 25 | 50 | 100 } = {},
): Promise<RobloxInventoryPlace[]> {
  if (!isValidRobloxId(userId)) return [];
  const maxPages = options.maxPages ?? 1;
  const pageSize = options.pageSize ?? 50;
  const places: RobloxInventoryPlace[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const payload = await client.request<RobloxPagedResponse<RobloxInventoryPlace>>({
      host: "inventory",
      path: `/v2/users/${userId}/inventory/${ASSET_TYPE_PLACE}`,
      query: { limit: pageSize, sortOrder: "Asc", cursor },
      label: `place inventory of user ${userId}`,
    });
    for (const entry of payload.data ?? []) {
      if (isValidRobloxId(entry.assetId)) places.push(entry);
    }
    if (!payload.nextPageCursor) break;
    cursor = payload.nextPageCursor;
  }
  return places;
}
