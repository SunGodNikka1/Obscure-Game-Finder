import { RobloxClient, ScanAbortedError, describeError, isAbort, isRateLimited, sleep } from "@/lib/roblox/client";
import { RequestBudget } from "@/lib/roblox/budget";
import { RobloxThrottle, describeThrottleEvent } from "@/lib/roblox/throttle";
import { fetchUserFavoriteGamesPage } from "@/lib/roblox/favorites";
import { listFriends } from "@/lib/roblox/friends";
import { fetchUserCreatedGamesPage, resolvePlaceToUniverse } from "@/lib/roblox/games";
import { fetchUserPlaceInventoryPage } from "@/lib/roblox/inventory";
import { getUsersByIds, resolveUsername, sanitizeUsername } from "@/lib/roblox/users";
import { summarisePlayability } from "@/lib/playability";
import { CONTINUOUS_CONFIG } from "@/lib/discovery/config";
import {
  advanceInventoryListing,
  clearPlaceRetry,
  isTransientPlaceFailure,
  notePlaceTransientFailure,
  prunePlaceRetries,
} from "@/lib/discovery/inventoryPolicy";
import { enforceRateLimit } from "@/lib/rateLimit";
import {
  buildPlaceOnlyGame,
  fallbackFromUserGameEntry,
  hydrateUniverses,
  type DiscoveryMeta,
  type FallbackGameInfo,
} from "@/lib/discovery/normalize";
import {
  placeOnlyKey,
  type ContinuousBatchPayload,
  type DiscoveredFriendRef,
  type FrontierNode,
  type LogLevel,
  type NodeWorkResult,
  type ScanEvent,
  type ScanStats,
  type UserFriendDiscovery,
  type UserSourceWork,
} from "@/lib/discovery/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/scan-batch
 *
 * Stateless, disposable batch worker for Continuous ∞ mode.
 *
 * Each invocation:
 *   - receives a small slice of frontier nodes (with per-source continuation cursors)
 *   - restores the crawler request-budget from client-carried state
 *   - performs a BOUNDED amount of work per user per source
 *   - streams logs / games / stats as NDJSON
 *   - returns every discovered public friend (never truncated)
 *   - returns updated per-user cursors so the client can re-queue unfinished users
 *   - emits exactly one `batchCheckpoint` carrying an explicit `ok` flag
 *
 * No server memory survives between requests. Everything needed to continue the
 * crawl travels in the payload and the checkpoint.
 */
export async function POST(request: Request): Promise<Response> {
  // Optional, env-gated abuse protection for public deployments.
  // The client-carried budget is UX/politeness, never security.
  const limited = await enforceRateLimit(request, "scan-batch");
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as ContinuousBatchPayload;
  const nodes: FrontierNode[] = Array.isArray(payload.nodes)
    ? payload.nodes.slice(0, CONTINUOUS_CONFIG.BATCH_USERS)
    : [];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: ScanEvent) => write(`${JSON.stringify(event)}\n`);

      write("\n");
      const heartbeat = setInterval(() => write("\n"), 10_000);

      const budget = new RequestBudget({ initialState: payload.budgetState ?? null });
      const throttle = new RobloxThrottle({ initialState: payload.throttleState ?? null });
      const batchStartedAt = Date.now();
      const batchDeadline = batchStartedAt + CONTINUOUS_CONFIG.BATCH_TIME_MS;
      const initialSnap = budget.snapshot();

      const stats: ScanStats = {
        http: initialSnap.http,
        friends: initialSnap.friends,
        refreshSeconds: initialSnap.refreshSeconds,
        requestsMade: 0,
        friendsFound: 0,
        usersScanned: 0,
        usersQueued: nodes.length,
        games: 0,
        playable: 0,
        closed: 0,
        failures: 0,
        rateLimited: 0,
        waitingSeconds: 0,
      };

      const log = (level: LogLevel, message: string) =>
        send({ type: "log", ts: Date.now(), level, message });

      const emitStats = () => {
        const snap = budget.snapshot();
        stats.http = snap.http;
        stats.friends = snap.friends;
        stats.refreshSeconds = snap.refreshSeconds;
        stats.requestsMade = client.requestCount;
        stats.failures = client.failureCount;
        stats.rateLimited = client.rateLimitHits;
        send({ type: "stats", ts: Date.now(), stats: { ...stats } });
      };

      const client = new RobloxClient({
        signal: request.signal,
        budget,
        throttle,
        // A shared cooldown that would outlast the batch is deferred to the next
        // batch (carried in throttleState) instead of burning the wall clock.
        deadline: batchDeadline,
        events: {
          onRequest: ({ count }) => {
            stats.requestsMade = count;
          },
          onBudgetWait: ({ kind, waitMs, label }) => {
            const seconds = Math.ceil(waitMs / 1000);
            stats.waitingSeconds = seconds;
            log(
              "warn",
              `[BUDGET] ${kind === "friends" ? "FriendList" : "HTTP"} budget exhausted. Pausing ${seconds}s until refill… (${label})`,
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
          onFailure: ({ label, status, message }) => {
            // A 429 is transient here: the work is kept for a later visit (see
            // the per-source handling below), so it is not reported as a failure.
            if (status === 429) log("warn", `Rate limited: ${label} — kept for a later visit`);
            else log("error", `Failed: ${label} — ${message}`);
          },
          onThrottle: (event) => {
            const { level, message } = describeThrottleEvent(event);
            stats.waitingSeconds = event.type === "waiting" ? Math.ceil(event.waitMs / 1000) : 0;
            log(level, message);
            emitStats();
          },
        },
      });

      const processedUserIds: number[] = [];
      const nodeResults: NodeWorkResult[] = [];
      const discoveredFriends: UserFriendDiscovery[] = [];
      const visitedGames = new Set<number>(payload.knownUniverseIds ?? []);

      const finish = (ok: boolean, reason?: string) => {
        const snap = budget.snapshot();
        stats.http = snap.http;
        stats.friends = snap.friends;
        stats.refreshSeconds = snap.refreshSeconds;
        stats.requestsMade = client.requestCount;
        stats.waitingSeconds = 0;
        send({
          type: "batchCheckpoint",
          ts: Date.now(),
          checkpoint: {
            ok,
            reason,
            processedUserIds,
            nodeResults,
            discoveredFriends,
            budgetState: budget.toState(),
            throttleState: throttle.toState(),
            stats: { ...stats },
          },
        });
      };

      try {
        // ---- Batch 1 of a continuous crawl: resolve the starting username ----
        if (nodes.length === 0 && payload.initialUsername) {
          const clean = sanitizeUsername(payload.initialUsername);
          if (!clean) {
            log("error", "Invalid username for continuous crawl.");
            stats.failures += 1;
            finish(false, "invalid-username");
            return;
          }
          log("system", `[START] Resolving username ${clean} for continuous ∞ crawl…`);
          emitStats();
          const user = await resolveUsername(client, clean);
          if (!user) {
            log("error", `Username "${clean}" not found on Roblox.`);
            stats.failures += 1;
            finish(false, "username-not-found");
            return;
          }
          log("ok", `Resolved starting player ${user.name} (#${user.id}).`);
          send({
            type: "target",
            ts: Date.now(),
            userId: user.id,
            username: user.name,
            displayName: user.displayName,
          });
          nodes.push({
            userId: user.id,
            username: user.name,
            depth: 0,
            parentUserId: null,
            pathTail: [user.name],
          });
        }

        for (const node of nodes) {
          client.throwIfAborted();

          if (Date.now() - batchStartedAt > CONTINUOUS_CONFIG.BATCH_TIME_MS) {
            log("warn", "[BATCH] Wall-clock budget reached. Remaining users stay queued.");
            break;
          }
          if (client.cooldownOutlastsDeadline()) {
            log(
              "warn",
              `[THROTTLE] Roblox cooldown (${Math.ceil(client.throttle.remainingMs() / 1000)}s) outlasts this batch · remaining users stay queued for the next batch.`,
            );
            break;
          }

          const work: UserSourceWork = { ...(node.work ?? {}) };
          const pathTail = node.pathTail ?? [node.username];

          stats.waitingSeconds = 0;
          stats.usersScanned += 1;
          log("system", `[SCAN] ${node.username}`);
          send({
            type: "scanning",
            ts: Date.now(),
            userId: node.userId,
            username: node.username,
            depth: node.depth,
          });
          emitStats();

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
              discoveryPath: pathTail,
              discoveryReason: reason,
            });
            fallback.set(universeId, info);
          };

          // ---- 1. Created experiences (one page per visit) ----
          if (payload.includeCreated && !work.createdDone) {
            try {
              for (let i = 0; i < CONTINUOUS_CONFIG.CREATED_PAGES_PER_VISIT; i += 1) {
                const page = await fetchUserCreatedGamesPage(client, node.userId, work.createdCursor);
                for (const entry of page.items) {
                  record(entry.id, "created", fallbackFromUserGameEntry(entry));
                }
                work.createdCursor = page.nextCursor;
                if (!page.nextCursor) {
                  work.createdDone = true;
                  break;
                }
              }
              log(
                "info",
                `[CREATED] +${meta.size} queued${work.createdDone ? " · complete" : " · more pages pending"}`,
              );
            } catch (error) {
              if (isAbort(error)) throw error;
              if (isRateLimited(error)) {
                // Transient: keep the source and its cursor for a later visit.
                log("warn", `[CREATED] rate limited for ${node.username} · kept for a later visit`);
              } else {
                work.createdDone = true; // hidden/unavailable: stop retrying this source
                log("warn", `[CREATED] unavailable for ${node.username} — ${describeError(error)}`);
              }
            }
            emitStats();
          }

          // ---- 2. Favourites (one page per visit) ----
          if (payload.includeFavorites && !work.favoritesDone) {
            const before = meta.size;
            try {
              for (let i = 0; i < CONTINUOUS_CONFIG.FAVORITES_PAGES_PER_VISIT; i += 1) {
                const page = await fetchUserFavoriteGamesPage(client, node.userId, work.favoritesCursor);
                for (const entry of page.items) {
                  record(entry.id, "favorite", fallbackFromUserGameEntry(entry));
                }
                work.favoritesCursor = page.nextCursor;
                if (!page.nextCursor) {
                  work.favoritesDone = true;
                  break;
                }
              }
              log(
                "info",
                `[FAV] +${meta.size - before} queued${work.favoritesDone ? " · complete" : " · more pages pending"}`,
              );
            } catch (error) {
              if (isAbort(error)) throw error;
              if (isRateLimited(error)) {
                log("warn", `[FAV] rate limited for ${node.username} · kept for a later visit`);
              } else {
                work.favoritesDone = true;
                log("warn", `[FAV] unavailable for ${node.username} (may be hidden) — ${describeError(error)}`);
              }
            }
            emitStats();
          }

          // ---- 3. Inventory: one page of places per visit (with backpressure) ----
          // The cursor only advances after every id on a page is queued; when
          // the queue cannot absorb a full page, fetching is deferred to a later
          // visit and resumes from the same cursor. See discovery/inventoryPolicy.ts.
          const pending: number[] = Array.isArray(work.pendingPlaceIds) ? [...work.pendingPlaceIds] : [];
          if (payload.includeInventory && !work.inventoryDone) {
            try {
              const visit = await advanceInventoryListing(work, pending, (cursor) =>
                fetchUserPlaceInventoryPage(client, node.userId, cursor),
              );
              if (visit.deferred && visit.pagesFetched === 0) {
                log(
                  "info",
                  `[INV] queue at ${pending.length}/${CONTINUOUS_CONFIG.MAX_PENDING_PLACES_PER_USER} · deferring next page until resolved`,
                );
              } else {
                log(
                  "info",
                  `[INV] ${pending.length} place${pending.length === 1 ? "" : "s"} awaiting resolution${work.inventoryDone ? " · listing complete" : " · more pages pending"}`,
                );
              }
            } catch (error) {
              if (isAbort(error)) throw error;
              if (isRateLimited(error)) {
                // advanceInventoryListing leaves cursor and queue untouched on error.
                log("warn", `[INV] rate limited for ${node.username} · listing kept for a later visit`);
              } else {
                work.inventoryDone = true;
                log("warn", `[INV] unavailable for ${node.username} (may be hidden) — ${describeError(error)}`);
              }
            }
            emitStats();
          }

          // ---- 3b. Resolve a bounded slice of pending places ----
          const placeOnlyRecords: Array<{ placeId: number; name: string | null; created: string | null }> = [];
          if (pending.length > 0) {
            const slice = pending.splice(0, CONTINUOUS_CONFIG.PLACES_RESOLVED_PER_VISIT);
            const placeRetries: Record<string, number> = { ...(work.placeRetries ?? {}) };
            const retryLater: number[] = [];
            const maxAttempts = CONTINUOUS_CONFIG.PLACE_TRANSIENT_ATTEMPTS;
            let resolved = 0;
            let attempted = 0;
            let throttledBack = 0;
            for (let index = 0; index < slice.length; index += 1) {
              const placeId = slice[index];
              client.throwIfAborted();
              let universeId: number | null = null;
              try {
                universeId = await resolvePlaceToUniverse(client, placeId);
              } catch (error) {
                if (isAbort(error)) throw error;
                if (isRateLimited(error)) {
                  // 429 is transient: this place and the rest of the slice stay
                  // queued (front of the queue, same order) for a later visit
                  // instead of being written off as unresolved partial records.
                  const unprocessed = slice.slice(index);
                  pending.unshift(...unprocessed);
                  throttledBack = unprocessed.length;
                  break;
                }
                if (isTransientPlaceFailure(error)) {
                  // Network failure / timeout / 5xx says nothing about the place:
                  // keep it queued for a later visit, a bounded number of times.
                  const decision = notePlaceTransientFailure(placeRetries, placeId, maxAttempts);
                  if (!decision.giveUp) {
                    retryLater.push(placeId);
                    log("warn", `[INV] place ${placeId} transient failure · retry ${decision.attempts}/${maxAttempts} kept queued`);
                    continue;
                  }
                  log(
                    "warn",
                    `[INV] place ${placeId} unresolved after ${decision.attempts} transient attempts · preserved as partial record`,
                  );
                }
                universeId = null;
              }
              // Answered (resolved, or terminally unresolvable): retry state is done.
              clearPlaceRetry(placeRetries, placeId);
              attempted += 1;
              if (universeId && !visitedGames.has(universeId)) {
                record(universeId, "inventory", { rootPlaceId: placeId });
                resolved += 1;
              } else if (!universeId) {
                placeOnlyRecords.push({ placeId, name: null, created: null });
              }
            }
            // Retries go to the back so healthy places are tried first next visit.
            // The queue never grows: these ids were just taken off it.
            pending.push(...retryLater);
            work.placeRetries = prunePlaceRetries(placeRetries, pending);
            log(
              "info",
              `[INV] resolved ${resolved}/${attempted} place${attempted === 1 ? "" : "s"}` +
                (throttledBack > 0 ? ` · ${throttledBack} kept queued (rate limited)` : "") +
                (retryLater.length > 0 ? ` · ${retryLater.length} kept for retry (transient failure)` : "") +
                (pending.length > 0 ? ` · ${pending.length} still queued for this user` : " · queue clear"),
            );
            emitStats();
          }
          work.pendingPlaceIds = pending;

          // ---- Emit preserved partial (place-only) records ----
          if (placeOnlyRecords.length > 0) {
            const preserved = placeOnlyRecords
              .filter((entry) => !visitedGames.has(placeOnlyKey(entry.placeId)))
              .map((entry) => {
                visitedGames.add(placeOnlyKey(entry.placeId));
                return buildPlaceOnlyGame(entry, {
                  discoveredByUserId: node.userId,
                  discoveredByUserName: node.username,
                  discoveryDepth: node.depth,
                  discoveryPath: pathTail,
                  discoveryReason: "inventory",
                });
              });
            if (preserved.length > 0) {
              stats.games += preserved.length;
              send({ type: "games", ts: Date.now(), games: preserved });
              log("info", `[INV] ${preserved.length} unresolved place(s) preserved as partial records.`);
              emitStats();
            }
          }

          // ---- Hydrate everything queued this visit ----
          const pendingIds = Array.from(meta.keys());
          if (pendingIds.length > 0) {
            try {
              const games = await hydrateUniverses(
                client,
                pendingIds,
                (universeId) =>
                  meta.get(universeId) ?? {
                    discoveredByUserId: node.userId,
                    discoveredByUserName: node.username,
                    discoveryDepth: node.depth,
                    discoveryPath: pathTail,
                    discoveryReason: "created",
                  },
                { fallback, maxDepth: Math.max(3, node.depth + 1) },
              );
              for (const game of games) visitedGames.add(game.universeId);
              stats.games += games.length;
              send({ type: "games", ts: Date.now(), games });

              const play = summarisePlayability(games);
              stats.playable += play.open;
              stats.closed += play.closed;
              if (games.length > 0) {
                log(
                  play.open === 0 && play.closed > 0 ? "warn" : "info",
                  `Playability: ${play.open} open · ${play.closed} closed` +
                    (play.unrated > 0 ? ` (${play.unrated} missing maturity label)` : "") +
                    (play.unknown > 0 ? ` · ${play.unknown} unknown` : ""),
                );
              }
            } catch (error) {
              if (isAbort(error)) throw error;
              log("error", `Metadata fetch failed for ${node.username} — ${describeError(error)}`);
            }
            emitStats();
          }

          // ---- 4. Friends: fetched exactly once per user, never truncated ----
          if (!work.friendsDone) {
            try {
              const rawFriends = await listFriends(client, node.userId);
              stats.friendsFound += rawFriends.length;
              log("info", `[FRIENDS] ${rawFriends.length} user${rawFriends.length === 1 ? "" : "s"}`);

              if (rawFriends.length > 0) {
                const missingNameIds = rawFriends.filter((f) => !f.name).map((f) => f.id);
                const resolved =
                  missingNameIds.length > 0 ? await getUsersByIds(client, missingNameIds) : new Map();
                const friendRefs: DiscoveredFriendRef[] = rawFriends.map((f) => ({
                  id: f.id,
                  name: f.name || resolved.get(f.id)?.name || `user_${f.id}`,
                }));
                discoveredFriends.push({ sourceUserId: node.userId, friends: friendRefs });
              }
              work.friendsDone = true;
            } catch (error) {
              if (isAbort(error)) throw error;
              if (isRateLimited(error)) {
                // friendsDone stays false -> the user is re-queued and friends retried.
                log("warn", `[FRIENDS] rate limited for ${node.username} · kept for a later visit`);
              } else {
                work.friendsDone = true;
                log("warn", `[FRIENDS] unavailable for ${node.username} — ${describeError(error)}`);
              }
            }
          }

          // ---- Per-user continuation bookkeeping ----
          const hasMoreWork =
            (payload.includeCreated && !work.createdDone) ||
            (payload.includeFavorites && !work.favoritesDone) ||
            (payload.includeInventory && !work.inventoryDone) ||
            (work.pendingPlaceIds?.length ?? 0) > 0 ||
            // Only a rate-limited friend fetch leaves this false after a visit.
            !work.friendsDone;

          nodeResults.push({ userId: node.userId, work, hasMoreWork });
          processedUserIds.push(node.userId);

          if (hasMoreWork) {
            log("info", `[WORK] ${node.username} has more public data pending — re-queued.`);
          }

          emitStats();
          await sleep(CONTINUOUS_CONFIG.USER_DELAY_MS, request.signal);
        }

        finish(true);
      } catch (error) {
        const aborted = request.signal.aborted || error instanceof ScanAbortedError || isAbort(error);
        if (aborted) {
          log("warn", "Batch stopped by user.");
          // An abort is not a failure: partial progress is valid and committable.
          finish(true, "aborted");
        } else {
          stats.failures += 1;
          log("error", `Batch halted: ${describeError(error)}`);
          finish(false, describeError(error));
        }
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
