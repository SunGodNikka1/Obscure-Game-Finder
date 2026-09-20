import type { RobloxClient } from "./client";
import { isValidRobloxId } from "./users";
import type { RobloxUniverseInfo } from "./types";

/** Roblox rejects >100 ids per call with `code 9: Too many universe IDs sent to get, the limit is: 100`. */
const UNIVERSE_CHUNK = 100;

/**
 * GET develop.roblox.com/v1/universes/multiget?ids=…&ids=…
 *
 * Works WITHOUT authentication (verified) and is the only public signal for
 * an experience's ACCESS setting. It matters because the anonymous
 * playability endpoint answers `GuestProhibited` for every experience that is
 * not rating-gated -- a friends-only or private experience looks exactly like
 * an open one from a guest's point of view (the guest check wins before any
 * permission check). Sampled against ~600 real universes: privacyType is one
 * of `Public`, `FriendsOnly`, `Private` or `Draft`, and every non-Public
 * universe also reports `isActive: false`.
 *
 * `classifyPlayability` in `src/lib/playability.ts` combines this with the
 * raw playability status; this module only fetches and stores the raw value.
 */
export async function getUniversePrivacy(
  client: RobloxClient,
  universeIds: number[],
): Promise<Map<number, RobloxUniverseInfo>> {
  const out = new Map<number, RobloxUniverseInfo>();
  const ids = Array.from(new Set(universeIds.filter(isValidRobloxId)));

  for (let i = 0; i < ids.length; i += UNIVERSE_CHUNK) {
    const group = ids.slice(i, i + UNIVERSE_CHUNK);
    try {
      const payload = await client.request<{ data?: RobloxUniverseInfo[] }>({
        host: "develop",
        path: "/v1/universes/multiget",
        query: { ids: group },
        label: `access settings for ${group.length} experiences`,
      });
      for (const entry of payload.data ?? []) {
        if (isValidRobloxId(entry.id) && typeof entry.privacyType === "string") {
          out.set(entry.id, entry);
        }
      }
    } catch {
      // Enrichment only: a failure leaves those games with privacyType null,
      // which falls back to the playability-status-only classification.
    }
  }
  return out;
}
