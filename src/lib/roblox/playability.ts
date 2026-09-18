import type { RobloxClient } from "./client";
import { isValidRobloxId } from "./users";
import type { RobloxPlayabilityEntry } from "./types";

/** Roblox rejects >50 ids per call with `code 9: Too many universe IDs were requested.` */
const PLAYABILITY_CHUNK = 50;

/**
 * GET games.roblox.com/v1/games/multiget-playability-status?universeIds=
 *
 * Works WITHOUT authentication (verified), but the answer is evaluated from an
 * anonymous viewer's perspective. Two consequences that the rest of the app
 * depends on:
 *
 *  - `isPlayable` is ALWAYS false anonymously, so it is useless on its own and
 *    is deliberately ignored. Only `playabilityStatus` is stored.
 *  - A live experience answers `GuestProhibited` ("you must sign in"), whereas
 *    an experience closed by the maturity-label/age-verification rollout
 *    answers `ContextualPlayabilityUnrated` (or a related contextual status).
 *
 * That distinction is what `classifyPlayability` in `src/lib/playability.ts`
 * turns into an open/closed verdict.
 */
export async function getPlayabilityStatuses(
  client: RobloxClient,
  universeIds: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = universeIds.filter(isValidRobloxId);

  for (let i = 0; i < ids.length; i += PLAYABILITY_CHUNK) {
    const group = ids.slice(i, i + PLAYABILITY_CHUNK);
    try {
      const payload = await client.request<RobloxPlayabilityEntry[] | { data?: RobloxPlayabilityEntry[] }>({
        host: "games",
        path: "/v1/games/multiget-playability-status",
        query: { universeIds: group.join(",") },
        label: `playability for ${group.length} experiences`,
      });
      // The endpoint returns a bare array; tolerate a wrapped shape too.
      const entries = Array.isArray(payload) ? payload : (payload.data ?? []);
      for (const entry of entries) {
        if (isValidRobloxId(entry.universeId) && typeof entry.playabilityStatus === "string") {
          out.set(entry.universeId, entry.playabilityStatus);
        }
      }
    } catch {
      // Playability is enrichment: a failure leaves those games "unknown".
    }
  }
  return out;
}
