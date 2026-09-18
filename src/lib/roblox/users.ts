import type { RobloxClient } from "./client";
import type { RobloxUserDetail, RobloxUserSummary } from "./types";

const USERNAME_PATTERN = /^[A-Za-z0-9_.]{3,25}$/;

export function sanitizeUsername(raw: string): string | null {
  const trimmed = raw.trim().replace(/^@/, "");
  if (!USERNAME_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function isValidRobloxId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 1e15;
}

/** POST users.roblox.com/v1/usernames/users -> username to id */
export async function resolveUsername(
  client: RobloxClient,
  username: string,
): Promise<RobloxUserSummary | null> {
  const payload = await client.request<{ data?: RobloxUserSummary[] }>({
    host: "users",
    path: "/v1/usernames/users",
    method: "POST",
    body: { usernames: [username], excludeBannedUsers: false },
    label: `resolve username ${username}`,
  });
  const entry = payload.data?.[0];
  if (!entry || !isValidRobloxId(entry.id)) return null;
  return { id: entry.id, name: entry.name, displayName: entry.displayName };
}

/** GET users.roblox.com/v1/users/{id} */
export async function getUserById(
  client: RobloxClient,
  userId: number,
): Promise<RobloxUserDetail | null> {
  if (!isValidRobloxId(userId)) return null;
  const payload = await client.request<RobloxUserDetail>({
    host: "users",
    path: `/v1/users/${userId}`,
    label: `fetch user ${userId}`,
  });
  if (!isValidRobloxId(payload.id)) return null;
  return payload;
}

/** POST users.roblox.com/v1/users -> batch id to username (max 100 per call) */
export async function getUsersByIds(
  client: RobloxClient,
  userIds: number[],
): Promise<Map<number, RobloxUserSummary>> {
  const result = new Map<number, RobloxUserSummary>();
  const ids = userIds.filter(isValidRobloxId);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const payload = await client.request<{ data?: RobloxUserSummary[] }>({
        host: "users",
        path: "/v1/users",
        method: "POST",
        body: { userIds: chunk, excludeBannedUsers: false },
        label: `resolve ${chunk.length} usernames`,
      });
      for (const entry of payload.data ?? []) {
        if (isValidRobloxId(entry.id)) result.set(entry.id, entry);
      }
    } catch {
      // Names are cosmetic for the discovery path; ids still work without them.
    }
  }
  return result;
}
