import type { RobloxClient } from "./client";
import { isValidRobloxId } from "./users";
import type { RobloxFriendEntry } from "./types";

/**
 * GET friends.roblox.com/v1/users/{userId}/friends
 *
 * Endpoint limitation discovered while building this: the unauthenticated
 * response frequently returns ids with EMPTY `name`/`displayName` strings, so
 * usernames for the discovery path must be back-filled with a batch call to
 * users.roblox.com/v1/users (see `getUsersByIds`).
 * Some accounts return 401/403 when their social graph is restricted -- callers
 * must treat a failure as "friend data unavailable" rather than fatal.
 */
export async function listFriends(
  client: RobloxClient,
  userId: number,
): Promise<RobloxFriendEntry[]> {
  const payload = await client.request<{ data?: RobloxFriendEntry[] }>({
    host: "friends",
    path: `/v1/users/${userId}/friends`,
    label: `friends of user ${userId}`,
    budgetKind: "friends",
  });
  return (payload.data ?? []).filter((entry) => isValidRobloxId(entry.id));
}
