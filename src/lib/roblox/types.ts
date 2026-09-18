/**
 * Raw shapes returned by the public Roblox web APIs that this app consumes.
 * Everything here is "as returned by Roblox" -- normalisation into the app's
 * own model happens in `src/lib/discovery`.
 */

export interface RobloxUserSummary {
  id: number;
  name: string;
  displayName: string;
  hasVerifiedBadge?: boolean;
}

export interface RobloxUserDetail extends RobloxUserSummary {
  description?: string | null;
  created?: string | null;
  isBanned?: boolean;
}

export interface RobloxPagedResponse<T> {
  previousPageCursor: string | null;
  nextPageCursor: string | null;
  data: T[];
}

/** games.roblox.com/v2/users/{id}/games and /favorite/games */
export interface RobloxUserGameEntry {
  id: number; // universe id
  name: string;
  description: string | null;
  creator: { id: number; type: string };
  rootPlace: { id: number; type: string } | null;
  created: string;
  updated: string;
  placeVisits: number | null;
}

/** games.roblox.com/v1/games?universeIds= */
export interface RobloxGameDetail {
  id: number;
  rootPlaceId: number;
  name: string;
  description: string | null;
  creator: {
    id: number;
    name: string;
    type: string;
    hasVerifiedBadge?: boolean;
  };
  playing: number | null;
  visits: number | null;
  maxPlayers: number | null;
  created: string | null;
  updated: string | null;
  genre: string | null;
  favoritedCount: number | null;
  isContentRestricted?: boolean;
}

/** games.roblox.com/v1/games/votes?universeIds= */
export interface RobloxGameVotes {
  id: number;
  upVotes: number;
  downVotes: number;
}

/** thumbnails.roblox.com/v1/games/multiget/thumbnails */
export interface RobloxThumbnailEntry {
  universeId: number;
  error: unknown;
  thumbnails: Array<{
    targetId: number;
    state: string;
    imageUrl: string | null;
  }>;
}

/** inventory.roblox.com/v2/users/{id}/inventory/9 -- `assetId` is a PLACE id */
export interface RobloxInventoryPlace {
  userAssetId: number;
  assetId: number;
  assetName: string | null;
  created: string | null;
  updated: string | null;
}

/** games.roblox.com/v1/games/multiget-playability-status (returns a bare array) */
export interface RobloxPlayabilityEntry {
  universeId: number;
  playabilityStatus: string;
  /** Always false for anonymous callers -- intentionally unused. */
  isPlayable: boolean;
  unplayableDisplayText: string | null;
}

/** friends.roblox.com/v1/users/{id}/friends */
export interface RobloxFriendEntry {
  id: number;
  name: string;
  displayName: string;
}
