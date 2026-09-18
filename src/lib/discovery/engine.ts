import { RobloxClient, ScanAbortedError, describeError, isAbort, sleep } from "@/lib/roblox/client";
import { listUserFavoriteGames } from "@/lib/roblox/favorites";
import { listFriends } from "@/lib/roblox/friends";
import { listUserCreatedGames, resolvePlaceToUniverse } from "@/lib/roblox/games";
import { listUserPlaceInventory } from "@/lib/roblox/inventory";
import { getUsersByIds, resolveUsername, sanitizeUsername } from "@/lib/roblox/users";
import { summarisePlayability } from "@/lib/playability";
import { DISCOVERY_LIMITS, clampDepth } from "./config";
import {
  buildPlaceOnlyGame,
  fallbackFromUserGameEntry,
  hydrateUniverses,
  type DiscoveryMeta,
  type FallbackGameInfo,
} from "./normalize";
import { placeOnlyKey, type LogLevel, type ScanEvent, type ScanRequestPayload, type ScanStats } from "./types";
import { RequestBudget, BUDGET_CONFIG } from "@/lib/roblox/budget";

interface QueueNode {
  userId: number;
  username: string;
  depth: number;
  path: string[];
}

function emptyStats(): ScanStats {
  return {
    http: BUDGET_CONFIG.HTTP_PER_WINDOW,
    friends: BUDGET_CONFIG.FRIENDS_PER_WINDOW,
    refreshSeconds: 0,
    requestsMade: 0,
    friendsFound: 0,
    usersScanned: 0,
    usersQueued: 0,
    games: 0,
    playable: 0,
    closed: 0,
    failures: 0,
    rateLimited: 0,
    waitingSeconds: 0,
  };
}

/**
 * Breadth-first friend-graph crawler.
 *
 *   visitedUsers : Set<number>   users already scanned or queued
 *   visitedGames : Set<number>   universes already emitted
 *   userQueue    : QueueNode[]   BFS frontier (depth-ordered)
 *
 * Depth 0 = starting user only. Depth 1 = + direct friends.
 * Depth 2 = + friends-of-friends. Everything is bounded by DISCOVERY_LIMITS.
 */
export async function* runDiscovery(
  payload: ScanRequestPayload,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent> {
  const outbox: ScanEvent[] = [];
  const stats = emptyStats();
  const startedAt = Date.now();
  const maxDepth = clampDepth(payload.depth);

  const push = (event: ScanEvent) => outbox.push(event);
  const log = (level: LogLevel, message: string) =>
    push({ type: "log", ts: Date.now(), level, message });

  const budget = new RequestBudget();
  const client = new RobloxClient({
    signal,
    budget,
    events: {
      onRequest: ({ count }) => {
        stats.requestsMade = count;
      },
      onBudgetWait: ({ kind, waitMs, label }) => {
        const seconds = Math.ceil(waitMs / 1000);
        stats.waitingSeconds = seconds;
        log(
          "warn",
          `[BUDGET] ${kind === "friends" ? "FriendList" : "HTTP"} budget exhausted. ` +
            `Pausing ${seconds}s until refill… (${label})`,
        );
        emitStats();
      },
      onRetry: ({ label, waitMs, reason }) => {
        stats.waitingSeconds = Math.ceil(waitMs / 1000);
        log(
          "warn",
          reason === "rate-limit"
            ? `Rate limited. Waiting ${stats.waitingSeconds}s… (${label})`
            : `Transient failure on ${label}. Retrying in ${stats.waitingSeconds}s…`,
        );
        emitStats();
      },
      onFailure: ({ label, message }) => {
        log("error", `Failed: ${label} — ${message}`);
      },
    },
  });

  function syncStats() {
    // `HTTP:` / `FriendList:` show REMAINING crawler budget, not requests made.
    const snapshot = budget.snapshot();
    stats.http = snapshot.http;
    stats.friends = snapshot.friends;
    stats.refreshSeconds = snapshot.refreshSeconds;
    stats.requestsMade = client.requestCount;
    stats.failures = client.failureCount;
    stats.rateLimited = client.rateLimitHits;
  }

  function emitStats() {
    syncStats();
    push({ type: "stats", ts: Date.now(), stats: { ...stats } });
  }

  function* drain(): Generator<ScanEvent> {
    while (outbox.length > 0) {
      yield outbox.shift() as ScanEvent;
    }
  }

  const username = sanitizeUsername(payload.username);
  if (!username) {
    log("error", "Invalid username. Use 3-25 characters: letters, digits, underscore or dot.");
    push({ type: "done", ts: Date.now(), ok: false, message: "Invalid username.", stats: { ...stats } });
    yield* drain();
    return;
  }

  log("system", `Resolving username ${username}…`);
  emitStats();
  yield* drain();

  try {
    const user = await resolveUsername(client, username);
    if (!user) {
      log("error", `Username "${username}" not found on Roblox.`);
      emitStats();
      push({ type: "done", ts: Date.now(), ok: false, message: "Username not found.", stats: { ...stats } });
      yield* drain();
      return;
    }

    log("ok", `Resolved user ID ${user.id} (${user.displayName}).`);
    push({ type: "target", ts: Date.now(), userId: user.id, username: user.name, displayName: user.displayName });
    log("system", `Scan depth ${maxDepth} • limits ${DISCOVERY_LIMITS.MAX_USERS} users / ${DISCOVERY_LIMITS.MAX_GAMES} games.`);
    emitStats();
    yield* drain();

    const visitedUsers = new Set<number>([user.id]);
    const visitedGames = new Set<number>();
    const visitedPlaces = new Set<number>();
    const userQueue: QueueNode[] = [{ userId: user.id, username: user.name, depth: 0, path: [user.name] }];
    stats.usersQueued = 1;

    while (userQueue.length > 0) {
      client.throwIfAborted();

      if (stats.usersScanned >= DISCOVERY_LIMITS.MAX_USERS) {
        log("warn", `User limit reached (${DISCOVERY_LIMITS.MAX_USERS}). Halting crawl.`);
        break;
      }
      if (visitedGames.size >= DISCOVERY_LIMITS.MAX_GAMES) {
        log("warn", `Game limit reached (${DISCOVERY_LIMITS.MAX_GAMES}). Halting crawl.`);
        break;
      }
      if (Date.now() - startedAt > DISCOVERY_LIMITS.SCAN_BUDGET_MS) {
        log("warn", "Scan time budget exhausted. Halting crawl.");
        break;
      }

      const node = userQueue.shift() as QueueNode;
      stats.usersQueued = userQueue.length;
      stats.usersScanned += 1;
      stats.waitingSeconds = 0;
      // "Players which are being scanned are displayed here." -- the current
      // player is announced with a [SCAN] tag and pushed as a `scanning` event
      // so the Processes panel can pin it above the log.
      log("system", `[SCAN] ${node.username}`);
      push({
        type: "scanning",
        ts: Date.now(),
        userId: node.userId,
        username: node.username,
        depth: node.depth,
      });
      emitStats();
      yield* drain();

      const meta = new Map<number, DiscoveryMeta>();
      const fallback = new Map<number, FallbackGameInfo>();

      const record = (
        universeId: number,
        reason: DiscoveryMeta["discoveryReason"],
        info: FallbackGameInfo,
      ) => {
        if (visitedGames.has(universeId) || meta.has(universeId)) return;
        meta.set(universeId, {
          discoveredByUserId: node.userId,
          discoveredByUserName: node.username,
          discoveryDepth: node.depth,
          discoveryPath: node.path,
          discoveryReason: reason,
        });
        fallback.set(universeId, info);
      };

      if (payload.includeCreated) {
        try {
          const created = await listUserCreatedGames(client, node.userId, {
            maxPages: DISCOVERY_LIMITS.CREATED_PAGES,
          });
          log("info", `[CREATED] ${created.length} experience${created.length === 1 ? "" : "s"}`);
          for (const entry of created) record(entry.id, "created", fallbackFromUserGameEntry(entry));
        } catch (error) {
          if (isAbort(error)) throw error;
          log("warn", `Created experiences unavailable for ${node.username} — ${describeError(error)}`);
        }
        emitStats();
        yield* drain();
      }

      if (payload.includeFavorites) {
        try {
          const favorites = await listUserFavoriteGames(client, node.userId, {
            maxPages: DISCOVERY_LIMITS.FAVORITE_PAGES,
          });
          log("info", `[FAV] ${favorites.length} experience${favorites.length === 1 ? "" : "s"}`);
          for (const entry of favorites) record(entry.id, "favorite", fallbackFromUserGameEntry(entry));
        } catch (error) {
          if (isAbort(error)) throw error;
          log("warn", `[FAV] unavailable for ${node.username} (list may be hidden) — ${describeError(error)}`);
        }
        emitStats();
        yield* drain();
      }

      // ---- PUBLIC PLACE INVENTORY (original OGF discovery source) ----------
      // Inventory entries are PLACE ids; each needs its own universe lookup, so
      // resolution is capped per user. Places whose universe cannot be resolved
      // are still preserved as place-only records (see placeOnlyRecords).
      const placeOnlyRecords: Array<{ placeId: number; name: string | null; created: string | null }> = [];
      if (payload.includeInventory) {
        try {
          const places = await listUserPlaceInventory(client, node.userId, {
            maxPages: DISCOVERY_LIMITS.INVENTORY_PAGES,
          });
          log("info", `[INV] ${places.length} place${places.length === 1 ? "" : "s"}`);

          const unseen = places.filter((entry) => !visitedPlaces.has(entry.assetId));
          const resolvable = unseen.slice(0, DISCOVERY_LIMITS.INVENTORY_MAX_RESOLVE_PER_USER);
          if (unseen.length > resolvable.length) {
            log(
              "info",
              `[INV] resolving ${resolvable.length} of ${unseen.length} new places (per-user cap).`,
            );
          }

          let resolved = 0;
          for (const entry of resolvable) {
            client.throwIfAborted();
            visitedPlaces.add(entry.assetId);
            let universeId: number | null = null;
            try {
              universeId = await resolvePlaceToUniverse(client, entry.assetId);
            } catch {
              universeId = null;
            }
            if (universeId && !visitedGames.has(universeId)) {
              record(universeId, "inventory", {
                name: entry.assetName,
                rootPlaceId: entry.assetId,
                created: entry.created,
                updated: entry.updated,
              });
              resolved += 1;
            } else if (!universeId) {
              // Preserve the discovery: we still have a real place identity.
              placeOnlyRecords.push({
                placeId: entry.assetId,
                name: entry.assetName,
                created: entry.created,
              });
            }
          }
          if (resolved > 0 || placeOnlyRecords.length > 0) {
            log(
              "info",
              `[INV] ${resolved} universe${resolved === 1 ? "" : "s"} resolved` +
                (placeOnlyRecords.length > 0
                  ? ` · ${placeOnlyRecords.length} kept as place-only record${placeOnlyRecords.length === 1 ? "" : "s"}`
                  : ""),
            );
          }
        } catch (error) {
          if (isAbort(error)) throw error;
          log("warn", `[INV] unavailable for ${node.username} (inventory may be hidden) — ${describeError(error)}`);
        }
        emitStats();
        yield* drain();
      }

      // Emit preserved place-only discoveries (universe unresolvable but the
      // place identity is real). Nothing is fabricated: unknown fields stay null.
      if (placeOnlyRecords.length > 0) {
        const preserved = placeOnlyRecords
          .filter((entry) => !visitedGames.has(placeOnlyKey(entry.placeId)))
          .map((entry) => {
            const key = placeOnlyKey(entry.placeId);
            visitedGames.add(key);
            return buildPlaceOnlyGame(entry, {
              discoveredByUserId: node.userId,
              discoveredByUserName: node.username,
              discoveryDepth: node.depth,
              discoveryPath: node.path,
              discoveryReason: "inventory",
            });
          });
        if (preserved.length > 0) {
          stats.games = visitedGames.size;
          push({ type: "games", ts: Date.now(), games: preserved });
          log("info", `[INV] ${preserved.length} unresolved place${preserved.length === 1 ? "" : "s"} preserved as partial records.`);
          emitStats();
          yield* drain();
        }
      }

      const remainingGameBudget = Math.max(0, DISCOVERY_LIMITS.MAX_GAMES - visitedGames.size);
      const pendingIds = Array.from(meta.keys()).slice(0, remainingGameBudget);

      if (pendingIds.length > 0) {
        log("info", `Fetching experience metadata… 0 / ${pendingIds.length} complete`);
        emitStats();
        yield* drain();

        try {
          const games = await hydrateUniverses(
            client,
            pendingIds,
            (universeId) =>
              meta.get(universeId) ?? {
                discoveredByUserId: node.userId,
                discoveredByUserName: node.username,
                discoveryDepth: node.depth,
                discoveryPath: node.path,
                discoveryReason: "created",
              },
            { fallback, maxDepth },
          );
          for (const game of games) visitedGames.add(game.universeId);
          stats.games = visitedGames.size;
          log("ok", `Fetching experience metadata… ${games.length} / ${pendingIds.length} complete`);
          push({ type: "games", ts: Date.now(), games });
          log("ok", `${games.length} new experience${games.length === 1 ? "" : "s"} recorded from ${node.username}.`);

          const play = summarisePlayability(games.map((game) => game.playabilityStatus));
          stats.playable += play.open;
          stats.closed += play.closed;
          if (games.length > 0) {
            log(
              play.open === 0 && play.closed > 0 ? "warn" : "info",
              `Playability: ${play.open} open · ${play.closed} closed` +
                (play.unrated > 0 ? ` (${play.unrated} missing a maturity label)` : "") +
                (play.unknown > 0 ? ` · ${play.unknown} unknown` : ""),
            );
          }
        } catch (error) {
          if (isAbort(error)) throw error;
          log("error", `Metadata fetch failed for ${node.username} — ${describeError(error)}`);
        }
      } else {
        log("info", `No new experiences from ${node.username}.`);
      }
      emitStats();
      yield* drain();

      if (node.depth < maxDepth && stats.usersScanned + userQueue.length < DISCOVERY_LIMITS.MAX_USERS) {
        try {
          const friends = await listFriends(client, node.userId);
          stats.friendsFound += friends.length;
          log("info", `[FRIENDS] ${friends.length} user${friends.length === 1 ? "" : "s"}`);

          const fresh = friends
            .filter((friend) => !visitedUsers.has(friend.id))
            .slice(0, DISCOVERY_LIMITS.MAX_FRIENDS_PER_USER);

          // friends.roblox.com often returns blank usernames -> back-fill them.
          const missingNames = fresh.filter((friend) => !friend.name).map((friend) => friend.id);
          const resolved = missingNames.length > 0 ? await getUsersByIds(client, missingNames) : new Map();

          for (const friend of fresh) {
            if (visitedUsers.size >= DISCOVERY_LIMITS.MAX_USERS) break;
            const name = friend.name || resolved.get(friend.id)?.name || `user_${friend.id}`;
            visitedUsers.add(friend.id);
            userQueue.push({
              userId: friend.id,
              username: name,
              depth: node.depth + 1,
              path: [...node.path, name],
            });
          }
          stats.usersQueued = userQueue.length;
          if (fresh.length > 0) {
            log("info", `${fresh.length} user${fresh.length === 1 ? "" : "s"} queued at depth ${node.depth + 1}.`);
          }
        } catch (error) {
          if (isAbort(error)) throw error;
          log("warn", `[FRIENDS] unavailable for ${node.username} — ${describeError(error)}`);
        }
        emitStats();
        yield* drain();
      }

      if (userQueue.length > 0) {
        await sleep(DISCOVERY_LIMITS.USER_DELAY_MS, signal);
      }
    }

    syncStats();
    stats.games = visitedGames.size;
    stats.waitingSeconds = 0;
    log("ok", `Scan complete. ${visitedGames.size} experience${visitedGames.size === 1 ? "" : "s"} discovered across ${stats.usersScanned} user${stats.usersScanned === 1 ? "" : "s"}.`);
    push({
      type: "done",
      ts: Date.now(),
      ok: true,
      message: `Scan complete. ${visitedGames.size} experiences discovered.`,
      stats: { ...stats },
    });
    yield* drain();
  } catch (error) {
    syncStats();
    if (error instanceof ScanAbortedError || isAbort(error)) {
      log("warn", "Scan aborted by user.");
      push({ type: "done", ts: Date.now(), ok: false, message: "Scan aborted by user.", stats: { ...stats } });
      yield* drain();
      return;
    }
    log("error", `Scan halted — ${describeError(error)}`);
    push({ type: "done", ts: Date.now(), ok: false, message: "Scan halted.", stats: { ...stats } });
    yield* drain();
  }
}
