"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sleep } from "@/lib/roblox/client";
import { BUDGET_CONFIG, type SerializedBudgetState } from "@/lib/roblox/budget";
import { CONTINUOUS_CONFIG } from "@/lib/discovery/config";
import { evaluateBatchOutcome, retryDelayMs } from "@/lib/discovery/batchPolicy";
import { clearCrawl, loadCrawl, saveCrawl, type PersistedCrawl } from "@/lib/persistence/crawlStore";
import type {
  BatchCheckpoint,
  DiscoveredGame,
  FrontierNode,
  LogLevel,
  ProcessLogEntry,
  ScanEvent,
  ScanStats,
} from "@/lib/discovery/types";

const MAX_LOGS = 400;

export interface ScanTarget {
  userId: number;
  username: string;
  displayName: string;
}

export interface ScanRequest {
  username: string;
  /** Finite depth: 0, 1, 2, 3. Continuous ∞: -1. */
  depth: number;
  includeCreated: boolean;
  includeFavorites: boolean;
  includeInventory: boolean;
  /**
   * "new"   -> clear the previously discovered pool and crawl state (default)
   * "merge" -> keep existing discoveries and add this target's findings
   */
  mode?: "new" | "merge";
}

/** The player currently being scanned, pinned above the Processes log. */
export interface ScanningUser {
  userId: number;
  username: string;
  depth: number;
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
 * Owns all live scan state on the client: the NDJSON stream reader, the process
 * log, counters, the abort controller, the continuous ∞ frontier loop, the
 * durable IndexedDB checkpoint, and the merged result set.
 */
export function useScanner() {
  const [games, setGames] = useState<DiscoveredGame[]>([]);
  const [logs, setLogs] = useState<ProcessLogEntry[]>([]);
  const [stats, setStats] = useState<ScanStats>(emptyStats);
  const [scanning, setScanning] = useState(false);
  const [target, setTarget] = useState<ScanTarget | null>(null);
  const [scanningUser, setScanningUser] = useState<ScanningUser | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  // Continuous ∞ state
  const [isContinuous, setIsContinuous] = useState(false);
  const [frontierLength, setFrontierLength] = useState(0);
  const [maxDepthReached, setMaxDepthReached] = useState(0);
  const [continuousPaused, setContinuousPaused] = useState(false);
  const [batchNumber, setBatchNumber] = useState(0);
  /** A crawl checkpoint found in IndexedDB on page load, awaiting user choice. */
  const [restorable, setRestorable] = useState<PersistedCrawl | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const userAbortRef = useRef(false);
  const seqRef = useRef(0);
  const gamesRef = useRef<DiscoveredGame[]>([]);

  // Client-owned continuous crawl state
  const continuousRunningRef = useRef(false);
  const frontierRef = useRef<FrontierNode[]>([]);
  const seenUserIdsRef = useRef<Set<number>>(new Set());
  const completedUserIdsRef = useRef<Set<number>>(new Set());
  const budgetStateRef = useRef<SerializedBudgetState | null>(null);
  const activeRequestRef = useRef<ScanRequest | null>(null);
  const targetRef = useRef<ScanTarget | null>(null);
  const batchNumberRef = useRef(0);
  const maxDepthRef = useRef(0);
  const cumulativeRef = useRef({
    usersScanned: 0,
    friendsFound: 0,
    requestsMade: 0,
    playable: 0,
    closed: 0,
  });
  /**
   * userId -> [parentUserId | null, username]
   *
   * The authoritative discovery graph lives here so request payloads never grow
   * with crawl depth (issue: unbounded `path` arrays). Full provenance paths are
   * reconstructed locally via `reconstructPath`.
   */
  const parentMapRef = useRef<Map<number, [number | null, string]>>(new Map());

  const log = useCallback((level: LogLevel, message: string) => {
    seqRef.current += 1;
    const entry: ProcessLogEntry = {
      id: `${Date.now()}-${seqRef.current}`,
      ts: Date.now(),
      level,
      message,
    };
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
  }, []);

  /** Walks the parent map back to the root, guarding against cycles. */
  const reconstructPath = useCallback((userId: number): string[] => {
    const out: string[] = [];
    const guard = new Set<number>();
    let cursor: number | null = userId;
    while (cursor !== null && !guard.has(cursor)) {
      guard.add(cursor);
      const entry = parentMapRef.current.get(cursor);
      if (!entry) break;
      out.push(entry[1]);
      cursor = entry[0];
    }
    return out.reverse();
  }, []);

  const addGames = useCallback(
    (incoming: DiscoveredGame[], rewritePaths = false): number => {
      const index = new Map(gamesRef.current.map((game) => [game.universeId, game]));
      let added = 0;
      for (const game of incoming) {
        if (!game || typeof game.universeId !== "number" || index.has(game.universeId)) continue;
        // Replace the server's bounded path tail with the full client-side path.
        const record =
          rewritePaths && typeof game.discoveredByUserId === "number"
            ? (() => {
                const full = reconstructPath(game.discoveredByUserId as number);
                return full.length > 0 ? { ...game, discoveryPath: full } : game;
              })()
            : game;
        index.set(game.universeId, record);
        added += 1;
      }
      if (added > 0) {
        const next = Array.from(index.values());
        gamesRef.current = next;
        setGames(next);
      }
      setLastUpdate(Date.now());
      return added;
    },
    [reconstructPath],
  );

  /**
   * Imports and other side-channel Roblox work are counted as REQUESTS MADE.
   *
   * They must never be added to `stats.http`, which is the REMAINING
   * crawler-budget token count -- adding to it would let the displayed budget
   * exceed its configured maximum and would be untruthful.
   */
  const noteExternalRequests = useCallback((count: number) => {
    if (count <= 0) return;
    setStats((prev) => ({ ...prev, requestsMade: prev.requestsMade + count }));
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  /** Wipes crawl bookkeeping. `keepGames` supports Merge Scan. */
  const resetCrawlState = useCallback((keepGames: boolean) => {
    continuousRunningRef.current = false;
    frontierRef.current = [];
    seenUserIdsRef.current = new Set();
    completedUserIdsRef.current = new Set();
    parentMapRef.current = new Map();
    budgetStateRef.current = null;
    batchNumberRef.current = 0;
    maxDepthRef.current = 0;
    cumulativeRef.current = {
      usersScanned: 0,
      friendsFound: 0,
      requestsMade: 0,
      playable: 0,
      closed: 0,
    };
    if (!keepGames) {
      gamesRef.current = [];
      setGames([]);
    }
    setFrontierLength(0);
    setMaxDepthReached(0);
    setBatchNumber(0);
    setStats(emptyStats());
    setContinuousPaused(false);
  }, []);

  const clearSession = useCallback(() => {
    userAbortRef.current = true;
    continuousRunningRef.current = false;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    resetCrawlState(false);
    activeRequestRef.current = null;
    targetRef.current = null;
    setTarget(null);
    setScanningUser(null);
    setLastUpdate(null);
    setIsContinuous(false);
    setScanning(false);
    setRestorable(null);
    void clearCrawl();
  }, [resetCrawlState]);

  const abort = useCallback(() => {
    userAbortRef.current = true;
    continuousRunningRef.current = false;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setScanning(false);
    setScanningUser(null);
    setStats((prev) => ({ ...prev, waitingSeconds: 0 }));

    if (isContinuous && frontierRef.current.length > 0) {
      setContinuousPaused(true);
      log(
        "warn",
        `Continuous crawl stopped by user. Frontier preserved: ${frontierRef.current.length} users. Press Resume to continue.`,
      );
    } else {
      log("warn", "Scan stopped by user.");
    }
  }, [isContinuous, log]);

  /* ---------------- Persistence ---------------- */

  const persistCheckpoint = useCallback(async () => {
    const request = activeRequestRef.current;
    if (!request) return;
    const snapshot: PersistedCrawl = {
      version: 1,
      savedAt: Date.now(),
      username: request.username,
      target: targetRef.current,
      sources: {
        includeCreated: request.includeCreated,
        includeFavorites: request.includeFavorites,
        includeInventory: request.includeInventory,
      },
      frontier: frontierRef.current,
      seenUserIds: Array.from(seenUserIdsRef.current),
      completedUserIds: Array.from(completedUserIdsRef.current),
      parentMap: Array.from(parentMapRef.current.entries()),
      budgetState: budgetStateRef.current,
      maxDepthReached: maxDepthRef.current,
      batchNumber: batchNumberRef.current,
      cumulative: { ...cumulativeRef.current },
      games: gamesRef.current,
    };
    await saveCrawl(snapshot);
  }, []);

  // Detect a recoverable crawl on mount. Never auto-resumes network activity.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await loadCrawl();
      if (!cancelled && saved && saved.frontier.length > 0) {
        setRestorable(saved);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const discardRestorable = useCallback(() => {
    setRestorable(null);
    void clearCrawl();
    log("system", "Saved crawl checkpoint discarded.");
  }, [log]);

  /* ---------------- Continuous ∞ Batch Loop ---------------- */

  const runContinuousLoop = useCallback(
    async (request: ScanRequest, resume = false) => {
      if (!resume) {
        // NEW vs MERGE is explicit: "new" clears the discovered pool, "merge"
        // keeps it and layers another target's findings on top.
        // resetCrawlState() also clears continuousRunningRef, so it must run
        // BEFORE the running flags are set below or the batch loop never starts.
        const merge = request.mode === "merge";
        resetCrawlState(merge);
        log(
          "system",
          merge
            ? `── continuous ∞ MERGE scan · ${request.username} · keeping ${gamesRef.current.length} existing games ──`
            : `── continuous ∞ crawl initiated · ${request.username} ──`,
        );
      } else {
        log(
          "system",
          `── continuous ∞ crawl resumed · frontier: ${frontierRef.current.length} users · batch ${batchNumberRef.current + 1} ──`,
        );
      }

      continuousRunningRef.current = true;
      userAbortRef.current = false;
      setScanning(true);
      setContinuousPaused(false);
      setIsContinuous(true);
      activeRequestRef.current = request;

      let isFirstBatch = !resume && frontierRef.current.length === 0;
      /** Consecutive failed batches; reset only on a genuinely successful batch. */
      let consecutiveFailures = 0;

      while (continuousRunningRef.current) {
        let nodesToProcess: FrontierNode[] = [];
        let initialUsername: string | undefined = undefined;

        if (isFirstBatch && frontierRef.current.length === 0) {
          initialUsername = request.username;
        } else {
          if (frontierRef.current.length === 0) {
            log("ok", "Continuous crawl complete. No additional reachable users remain.");
            continuousRunningRef.current = false;
            setScanning(false);
            setScanningUser(null);
            void clearCrawl();
            break;
          }
          nodesToProcess = frontierRef.current.splice(0, CONTINUOUS_CONFIG.BATCH_USERS);
          setFrontierLength(frontierRef.current.length);
        }

        const controller = new AbortController();
        abortRef.current = controller;

        let checkpoint: BatchCheckpoint | null = null;
        let transportError = "";

        try {
          const response = await fetch("/api/scan-batch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              initialUsername,
              nodes: nodesToProcess,
              includeCreated: request.includeCreated,
              includeFavorites: request.includeFavorites,
              includeInventory: request.includeInventory,
              budgetState: budgetStateRef.current,
              knownUniverseIds: gamesRef.current.slice(-400).map((g) => g.universeId),
            }),
            signal: controller.signal,
          });

          if (!response.ok || !response.body) {
            const detail = await response.text().catch(() => "");
            throw new Error(`HTTP ${response.status}: ${detail.slice(0, 80)}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              let event: ScanEvent;
              try {
                event = JSON.parse(line) as ScanEvent;
              } catch {
                continue;
              }
              switch (event.type) {
                case "log": {
                  // Build the entry OUTSIDE the updater: React batches queued
                  // updaters, so reading seqRef inside them yields duplicate ids
                  // (and duplicate React keys) for events sharing a millisecond.
                  seqRef.current += 1;
                  const entry: ProcessLogEntry = {
                    id: `${event.ts}-${seqRef.current}`,
                    ts: event.ts,
                    level: event.level,
                    message: event.message,
                  };
                  setLogs((prev) => {
                    const next = [...prev, entry];
                    return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
                  });
                  break;
                }
                case "stats":
                  setStats((prev) => ({
                    ...prev,
                    http: event.stats.http,
                    friends: event.stats.friends,
                    refreshSeconds: event.stats.refreshSeconds,
                    waitingSeconds: event.stats.waitingSeconds,
                    usersQueued: frontierRef.current.length,
                  }));
                  break;
                case "scanning":
                  setScanningUser({ userId: event.userId, username: event.username, depth: event.depth });
                  break;
                case "target": {
                  const resolved = {
                    userId: event.userId,
                    username: event.username,
                    displayName: event.displayName,
                  };
                  targetRef.current = resolved;
                  setTarget(resolved);
                  seenUserIdsRef.current.add(event.userId);
                  if (!parentMapRef.current.has(event.userId)) {
                    parentMapRef.current.set(event.userId, [null, event.username]);
                  }
                  setLastUpdate(Date.now());
                  break;
                }
                case "games":
                  addGames(event.games, true);
                  break;
                case "batchCheckpoint":
                  checkpoint = event.checkpoint;
                  break;
                default:
                  break;
              }
            }
          }
        } catch (error) {
          transportError = error instanceof Error ? error.message : "network failure";
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
        }

        /*
         * A checkpoint is emitted even when a batch fails, so success MUST be
         * judged by `checkpoint.ok`, never by the checkpoint merely existing.
         */
        const sawCheckpoint = checkpoint !== null;
        const batchSucceeded = sawCheckpoint && checkpoint!.ok === true;

        // ---- Commit whatever progress the batch did make (always safe) ----
        if (sawCheckpoint) {
          const cp = checkpoint!;
          budgetStateRef.current = cp.budgetState;

          const workById = new Map(cp.nodeResults.map((r) => [r.userId, r]));
          for (const uid of cp.processedUserIds) {
            completedUserIdsRef.current.add(uid);
            seenUserIdsRef.current.add(uid);
          }

          // Re-queue users that still have unexhausted public sources.
          //
          // Driven off nodeResults (not nodesToProcess) because on the very
          // first batch the starting user is resolved server-side and therefore
          // never appears in nodesToProcess -- iterating the request nodes would
          // silently drop the starting user's remaining pages/places.
          let requeued = 0;
          for (const result of cp.nodeResults) {
            if (!result.hasMoreWork) continue;
            const existing = nodesToProcess.find((n) => n.userId === result.userId);
            const reconstructed: FrontierNode | null =
              existing ??
              (targetRef.current && targetRef.current.userId === result.userId
                ? {
                    userId: result.userId,
                    username: targetRef.current.username,
                    depth: 0,
                    parentUserId: null,
                    pathTail: [targetRef.current.username],
                  }
                : null);
            if (reconstructed) {
              frontierRef.current.unshift({ ...reconstructed, work: result.work });
              requeued += 1;
            }
          }
          if (requeued > 0) {
            log("info", `[WORK] ${requeued} user(s) re-queued with remaining source pages.`);
          }

          // Enqueue every unseen friend (never truncated).
          let friendsAdded = 0;
          for (const discovery of cp.discoveredFriends) {
            const parentNode = nodesToProcess.find((n) => n.userId === discovery.sourceUserId);
            const parentDepth = parentNode?.depth ?? (isFirstBatch ? 0 : 0);
            const parentTail = parentNode?.pathTail ?? [request.username];
            const childDepth = parentDepth + 1;

            for (const friend of discovery.friends) {
              if (seenUserIdsRef.current.has(friend.id)) continue;
              seenUserIdsRef.current.add(friend.id);
              parentMapRef.current.set(friend.id, [discovery.sourceUserId, friend.name]);
              frontierRef.current.push({
                userId: friend.id,
                username: friend.name,
                depth: childDepth,
                parentUserId: discovery.sourceUserId,
                // Bounded tail only; the full path lives in parentMapRef.
                pathTail: [...parentTail, friend.name].slice(-CONTINUOUS_CONFIG.PATH_TAIL_LENGTH),
              });
              friendsAdded += 1;
              if (childDepth > maxDepthRef.current) maxDepthRef.current = childDepth;
            }
          }
          if (friendsAdded > 0) {
            log(
              "info",
              `[FRONTIER] +${friendsAdded} new user${friendsAdded === 1 ? "" : "s"} queued (frontier: ${frontierRef.current.length}).`,
            );
          }

          const deepest = nodesToProcess.reduce((max, n) => Math.max(max, n.depth), 0);
          if (deepest > maxDepthRef.current) maxDepthRef.current = deepest;
          setMaxDepthReached((prev) => {
            const next = Math.max(prev, maxDepthRef.current);
            if (next > prev) log("system", `[DEPTH] reached depth ${next}`);
            return next;
          });

          cumulativeRef.current.usersScanned = completedUserIdsRef.current.size;
          cumulativeRef.current.friendsFound += cp.stats.friendsFound;
          cumulativeRef.current.requestsMade += cp.stats.requestsMade;
          cumulativeRef.current.playable += cp.stats.playable;
          cumulativeRef.current.closed += cp.stats.closed;

          setFrontierLength(frontierRef.current.length);
          setStats((prev) => ({
            ...prev,
            usersScanned: cumulativeRef.current.usersScanned,
            usersQueued: frontierRef.current.length,
            games: gamesRef.current.length,
            playable: cumulativeRef.current.playable,
            closed: cumulativeRef.current.closed,
            friendsFound: cumulativeRef.current.friendsFound,
            requestsMade: cumulativeRef.current.requestsMade,
            failures: prev.failures + (batchSucceeded ? 0 : 1),
            http: cp.stats.http,
            friends: cp.stats.friends,
            refreshSeconds: cp.stats.refreshSeconds,
            waitingSeconds: 0,
          }));
        }

        // Users the server never reported on must go back to the frontier.
        const accounted = new Set(checkpoint?.processedUserIds ?? []);
        const unreached = nodesToProcess.filter((n) => !accounted.has(n.userId));
        if (unreached.length > 0) {
          frontierRef.current.unshift(...unreached);
          setFrontierLength(frontierRef.current.length);
        }

        // ---- Batch number: cumulative across Stop/Resume ----
        if (sawCheckpoint) {
          batchNumberRef.current += 1;
          setBatchNumber(batchNumberRef.current);
        }

        await persistCheckpoint();

        // ---- User stop ----
        if (userAbortRef.current || !continuousRunningRef.current) break;

        // ---- Failure handling: retry with backoff, then PAUSE ----
        if (!batchSucceeded) {
          consecutiveFailures += 1;
          const reason = checkpoint?.reason ?? transportError ?? "unknown error";
          const outcome = evaluateBatchOutcome({
            sawCheckpoint,
            checkpointOk: checkpoint?.ok === true,
            consecutiveFailures,
          });

          if (outcome === "pause") {
            continuousRunningRef.current = false;
            setContinuousPaused(true);
            setScanning(false);
            setScanningUser(null);
            log(
              "error",
              `[PAUSED] Continuous batch failed ${consecutiveFailures}× (${reason}). Frontier preserved: ${frontierRef.current.length} users. Press Resume to continue.`,
            );
            break;
          }

          const delay = retryDelayMs(consecutiveFailures);
          log(
            "warn",
            `[RETRY] Batch failed (${reason}). Attempt ${consecutiveFailures}/${CONTINUOUS_CONFIG.MAX_BATCH_ATTEMPTS} — retrying in ${Math.round(delay / 1000)}s.`,
          );
          try {
            await sleep(delay);
          } catch {
            break;
          }
          isFirstBatch = isFirstBatch && frontierRef.current.length === 0;
          continue;
        }

        // Genuine success only.
        consecutiveFailures = 0;
        isFirstBatch = false;

        if (continuousRunningRef.current && frontierRef.current.length > 0) {
          await sleep(CONTINUOUS_CONFIG.INTER_BATCH_DELAY_MS);
        }
      }

      setScanning(false);
      setScanningUser(null);
      setLastUpdate(Date.now());
      await persistCheckpoint();
    },
    [addGames, log, persistCheckpoint, resetCrawlState],
  );

  /* ---------------- Finite Scan (existing /api/scan) ---------------- */

  const runFiniteScan = useCallback(
    async (request: ScanRequest) => {
      if (abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      userAbortRef.current = false;
      continuousRunningRef.current = false;
      setIsContinuous(false);
      setContinuousPaused(false);
      setScanning(true);

      if (request.mode !== "merge") {
        resetCrawlState(false);
      } else {
        setStats(emptyStats());
      }
      activeRequestRef.current = request;

      log(
        "system",
        `── ${request.mode === "merge" ? "merge " : ""}scan initiated · ${request.username} · depth ${request.depth} ──`,
      );

      try {
        const response = await fetch("/api/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          log("error", `Backend refused the scan (HTTP ${response.status}). ${detail.slice(0, 120)}`);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let event: ScanEvent;
            try {
              event = JSON.parse(line) as ScanEvent;
            } catch {
              continue;
            }
            switch (event.type) {
              case "log": {
                // See the continuous loop: the entry must be built outside the updater.
                seqRef.current += 1;
                const entry: ProcessLogEntry = {
                  id: `${event.ts}-${seqRef.current}`,
                  ts: event.ts,
                  level: event.level,
                  message: event.message,
                };
                setLogs((prev) => {
                  const next = [...prev, entry];
                  return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
                });
                break;
              }
              case "stats":
                setStats(event.stats);
                break;
              case "scanning":
                setScanningUser({ userId: event.userId, username: event.username, depth: event.depth });
                break;
              case "target": {
                const resolved = {
                  userId: event.userId,
                  username: event.username,
                  displayName: event.displayName,
                };
                targetRef.current = resolved;
                setTarget(resolved);
                setLastUpdate(Date.now());
                break;
              }
              case "games":
                addGames(event.games);
                break;
              case "done":
                setStats(event.stats);
                setLastUpdate(Date.now());
                break;
              default:
                break;
            }
          }
        }
      } catch (error) {
        if (userAbortRef.current || controller.signal.aborted) {
          // abort() already logged the message
        } else {
          const message = error instanceof Error ? error.message : "unknown network failure";
          log("error", `Network failure talking to the backend — ${message}`);
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setScanning(false);
        setScanningUser(null);
        setStats((prev) => ({ ...prev, waitingSeconds: 0 }));
        setLastUpdate(Date.now());
      }
    },
    [addGames, log, resetCrawlState],
  );

  /* ---------------- Unified Start / Resume / Restore ---------------- */

  const start = useCallback(
    async (request: ScanRequest) => {
      if (scanning || continuousRunningRef.current) return;
      setRestorable(null);
      if (request.depth === -1) {
        await runContinuousLoop(request, false);
      } else {
        await runFiniteScan(request);
      }
    },
    [runContinuousLoop, runFiniteScan, scanning],
  );

  const resumeContinuous = useCallback(async () => {
    if (scanning || continuousRunningRef.current || !activeRequestRef.current) return;
    await runContinuousLoop(activeRequestRef.current, true);
  }, [runContinuousLoop, scanning]);

  /** Rehydrate a crawl saved in IndexedDB, then continue it. */
  const restoreAndResume = useCallback(async () => {
    const saved = restorable;
    if (!saved || scanning || continuousRunningRef.current) return;

    frontierRef.current = saved.frontier;
    seenUserIdsRef.current = new Set(saved.seenUserIds);
    completedUserIdsRef.current = new Set(saved.completedUserIds);
    parentMapRef.current = new Map(saved.parentMap);
    budgetStateRef.current = saved.budgetState;
    batchNumberRef.current = saved.batchNumber;
    maxDepthRef.current = saved.maxDepthReached;
    cumulativeRef.current = { ...saved.cumulative };
    gamesRef.current = saved.games;

    setGames(saved.games);
    setTarget(saved.target);
    targetRef.current = saved.target;
    setFrontierLength(saved.frontier.length);
    setMaxDepthReached(saved.maxDepthReached);
    setBatchNumber(saved.batchNumber);
    setIsContinuous(true);
    setRestorable(null);
    setStats((prev) => ({
      ...prev,
      usersScanned: saved.cumulative.usersScanned,
      usersQueued: saved.frontier.length,
      games: saved.games.length,
      playable: saved.cumulative.playable,
      closed: saved.cumulative.closed,
      friendsFound: saved.cumulative.friendsFound,
      requestsMade: saved.cumulative.requestsMade,
    }));

    const request: ScanRequest = {
      username: saved.username,
      depth: -1,
      includeCreated: saved.sources.includeCreated,
      includeFavorites: saved.sources.includeFavorites,
      includeInventory: saved.sources.includeInventory,
    };
    activeRequestRef.current = request;

    log(
      "system",
      `Restored saved crawl · ${saved.games.length} games · frontier ${saved.frontier.length} · batch ${saved.batchNumber}.`,
    );
    await runContinuousLoop(request, true);
  }, [log, restorable, runContinuousLoop, scanning]);

  return {
    games,
    logs,
    stats,
    scanning,
    target,
    scanningUser,
    lastUpdate,
    isContinuous,
    frontierLength,
    maxDepthReached,
    continuousPaused,
    batchNumber,
    restorable,
    log,
    addGames,
    noteExternalRequests,
    clearLogs,
    clearSession,
    start,
    abort,
    resumeContinuous,
    restoreAndResume,
    discardRestorable,
  };
}
