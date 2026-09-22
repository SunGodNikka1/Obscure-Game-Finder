import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import type { BatchCheckpoint, ContinuousBatchPayload, DiscoveredGame, ScanEvent } from "@/lib/discovery/types";
import type { SerializedThrottleState } from "@/lib/roblox/throttle";

/**
 * The real /api/scan-batch handler against a mocked Roblox. Time is virtual
 * (fake timers), so multi-second cooldowns run instantly and deterministically.
 */
const T0 = Date.parse("2026-09-22T12:00:00Z");
type Rule = (url: URL) => { status: number; body?: unknown } | "network" | "abort" | undefined;
let abortController: AbortController | null = null;

let rules: Rule[];
let fetches: Array<{ url: string; at: number }>;

function robloxOk(url: URL): { status: number; body?: unknown } {
  const p = url.pathname;
  if (url.host === "games.roblox.com" && /\/v2\/users\/\d+\/games$/.test(p)) return { status: 200, body: { data: [], nextPageCursor: null } };
  if (url.host === "games.roblox.com" && /favorite\/games$/.test(p)) return { status: 200, body: { data: [], nextPageCursor: null } };
  if (url.host === "inventory.roblox.com")
    return { status: 200, body: { data: [101, 102, 103].map((assetId) => ({ assetId, name: `p${assetId}` })), nextPageCursor: null } };
  if (url.host === "apis.roblox.com") {
    const placeId = Number(p.split("/")[4]);
    return { status: 200, body: { universeId: placeId * 10 } };
  }
  if (url.host === "games.roblox.com" && p === "/v1/games") {
    const ids = (url.searchParams.get("universeIds") ?? "").split(",").filter(Boolean).map(Number);
    return { status: 200, body: { data: ids.map((id) => ({ id, rootPlaceId: id / 10, name: `Game ${id}`, creator: { id: 1, name: "c", type: "User" } })) } };
  }
  if (url.host === "friends.roblox.com") return { status: 200, body: { data: [{ id: 7, name: "friend7" }] } };
  if (url.host === "develop.roblox.com") return { status: 200, body: { data: [] } };
  if (url.host === "thumbnails.roblox.com") return { status: 200, body: { data: [] } };
  if (p.includes("playability")) return { status: 200, body: [] };
  return { status: 200, body: { data: [] } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  rules = [];
  fetches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      fetches.push({ url: input, at: Date.now() });
      const hit = rules.map((r) => r(url)).find(Boolean) ?? robloxOk(url);
      if (hit === "network") throw new TypeError("fetch failed");
      if (hit === "abort") {
        abortController?.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(JSON.stringify(hit.body ?? {}), { status: hit.status });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const node = { userId: 1, username: "u1", depth: 1, parentUserId: null, pathTail: ["u1"] };

async function runBatch(payload: Partial<ContinuousBatchPayload>) {
  const body: ContinuousBatchPayload = {
    nodes: [node],
    includeCreated: true,
    includeFavorites: true,
    includeInventory: true,
    budgetState: null,
    knownUniverseIds: [],
    ...payload,
  };
  abortController = new AbortController();
  const response = await POST(
    new Request("http://localhost/api/scan-batch", { method: "POST", body: JSON.stringify(body), signal: abortController.signal }),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let finished = false;
  const pump = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    finished = true;
  })();
  while (!finished) await vi.advanceTimersByTimeAsync(250);
  await pump;
  const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ScanEvent);
  const checkpoint = (events.find((e) => e.type === "batchCheckpoint") as { checkpoint: BatchCheckpoint }).checkpoint;
  const games = events.filter((e) => e.type === "games").flatMap((e) => (e as { games: DiscoveredGame[] }).games);
  const logs = events.filter((e) => e.type === "log").map((e) => (e as { message: string }).message);
  return { checkpoint, games, logs, work: checkpoint.nodeResults.find((r) => r.userId === 1) };
}

describe("scan-batch under Roblox throttling", () => {
  it("baseline: without 429s every place resolves and the user is finished", async () => {
    const { checkpoint, games, work } = await runBatch({});
    expect(checkpoint.ok).toBe(true);
    expect(work?.work.pendingPlaceIds).toEqual([]);
    expect(work?.work.friendsDone).toBe(true);
    expect(work?.hasMoreWork).toBe(false);
    expect(games.map((g) => g.universeId).sort()).toEqual([1010, 1020, 1030]);
    expect(checkpoint.throttleState?.level).toBe(0);
  });

  it("13. a 429 during place resolution keeps that place (and the rest of the slice) queued -- no partial record", async () => {
    rules.push((url) => (url.host === "apis.roblox.com" && url.pathname.includes("/places/102/") ? { status: 429 } : undefined));
    const { checkpoint, games, logs, work } = await runBatch({});
    expect(checkpoint.ok).toBe(true);
    expect(work?.work.pendingPlaceIds).toEqual([102, 103]);
    expect(work?.hasMoreWork).toBe(true); // re-queued for a later batch
    expect(games.some((g) => !g.universeKnown)).toBe(false); // nothing written off as "unresolved"
    expect(games.map((g) => g.universeId)).toContain(1010);
    expect(logs.some((m) => /kept queued \(rate limited\)/.test(m))).toBe(true);
    expect(logs.filter((m) => m.startsWith("[THROTTLE]")).length).toBeGreaterThan(0);
    expect(checkpoint.throttleState?.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("14. 429s on listing sources / friends keep them open with cursors intact (not 'unavailable')", async () => {
    rules.push((url) => (url.host === "games.roblox.com" && /favorite\/games$/.test(url.pathname) ? { status: 429 } : undefined));
    rules.push((url) => (url.host === "friends.roblox.com" ? { status: 429 } : undefined));
    const { work, logs } = await runBatch({
      nodes: [{ ...node, work: { favoritesCursor: "cursor-7" } }],
    });
    expect(work?.work.favoritesDone).toBeFalsy();
    expect(work?.work.favoritesCursor).toBe("cursor-7");
    expect(work?.work.friendsDone).toBeFalsy();
    expect(work?.hasMoreWork).toBe(true);
    expect(logs.some((m) => /\[FAV\] rate limited/.test(m))).toBe(true);
    expect(logs.some((m) => /\[FRIENDS\] unavailable/.test(m))).toBe(false);
  });

  it("terminal behaviour is unchanged: a 403 inventory is still 'unavailable' and done", async () => {
    rules.push((url) => (url.host === "inventory.roblox.com" ? { status: 403 } : undefined));
    const { work, logs } = await runBatch({});
    expect(work?.work.inventoryDone).toBe(true);
    expect(logs.some((m) => /\[INV\] unavailable/.test(m))).toBe(true);
  });

  it("12a. a carried active cooldown is respected by the next batch before any Roblox call", async () => {
    const throttleState: SerializedThrottleState = { cooldownUntil: T0 + 20_000, level: 2, successes: 0, lastThrottleAt: T0 - 1_000 };
    const { checkpoint } = await runBatch({ throttleState });
    expect(checkpoint.ok).toBe(true);
    expect(fetches.length).toBeGreaterThan(0);
    expect(Math.min(...fetches.map((f) => f.at))).toBeGreaterThanOrEqual(T0 + 20_000);
  });

  it("12b. a carried cooldown that outlasts the batch defers cleanly: no Roblox calls, users stay queued, state carried on", async () => {
    const throttleState: SerializedThrottleState = { cooldownUntil: T0 + 60_000, level: 4, successes: 0, lastThrottleAt: T0 };
    const { checkpoint, logs } = await runBatch({ throttleState });
    expect(fetches).toHaveLength(0);
    expect(checkpoint.ok).toBe(true);
    expect(checkpoint.processedUserIds).toEqual([]); // client re-queues unreported users
    expect(checkpoint.throttleState?.cooldownUntil).toBe(T0 + 60_000);
    expect(logs.some((m) => /outlasts this batch/.test(m))).toBe(true);
  });

  it("12c. an expired carried cooldown resumes at normal speed", async () => {
    const throttleState: SerializedThrottleState = { cooldownUntil: T0 - 1, level: 1, successes: 0, lastThrottleAt: T0 - 9_000 };
    await runBatch({ throttleState });
    expect(Math.min(...fetches.map((f) => f.at))).toBe(T0);
  });
});

describe("transient failures during place resolution", () => {
  const PLACE = 102; // stands in for live place 2534724415
  const failPlace = (mode: "network" | "abort" | { status: number }) =>
    rules.push((url) => (url.host === "apis.roblox.com" && url.pathname.includes(`/places/${PLACE}/`) ? mode : undefined));
  /** A user whose listings are done and whose places are all pending, so only resolution runs. */
  const pendingNode = (placeRetries?: Record<string, number>, pendingPlaceIds = [101, 102, 103]) => ({
    ...node,
    work: { createdDone: true, favoritesDone: true, inventoryDone: true, friendsDone: true, pendingPlaceIds, placeRetries },
  });
  const roundTrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  it("1. a first network failure keeps the place queued (no partial record) with retry 1/3", async () => {
    failPlace("network");
    const { games, logs, work } = await runBatch({ nodes: [pendingNode()] });
    expect(work?.work.pendingPlaceIds).toEqual([PLACE]);
    expect(work?.work.placeRetries).toEqual({ [PLACE]: 1 });
    expect(work?.hasMoreWork).toBe(true);
    expect(games.some((g) => !g.universeKnown)).toBe(false);
    expect(games.map((g) => g.universeId).sort()).toEqual([1010, 1030]); // 10. the others resolve normally
    expect(logs).toContain(`[INV] place ${PLACE} transient failure · retry 1/3 kept queued`);
  });

  it("2/3. the count survives batch serialisation and increments on the next transient failure", async () => {
    failPlace("network");
    const first = await runBatch({ nodes: [pendingNode()] });
    const carried = roundTrip(first.work!.work); // exactly what the browser sends back
    const second = await runBatch({ nodes: [{ ...node, work: carried }] });
    expect(second.work?.work.placeRetries).toEqual({ [PLACE]: 2 });
    expect(second.work?.work.pendingPlaceIds).toEqual([PLACE]);
    expect(second.logs).toContain(`[INV] place ${PLACE} transient failure · retry 2/3 kept queued`);
  });

  it("4. an eventual success resolves normally and clears the retry state", async () => {
    const { games, work } = await runBatch({ nodes: [pendingNode({ [PLACE]: 2 })] });
    expect(games.map((g) => g.universeId)).toContain(PLACE * 10);
    expect(work?.work.pendingPlaceIds).toEqual([]);
    expect(work?.work.placeRetries).toBeUndefined();
    expect(work?.hasMoreWork).toBe(false);
  });

  it("5. the cap falls back to the partial record instead of looping forever", async () => {
    failPlace("network");
    const { games, logs, work } = await runBatch({ nodes: [pendingNode({ [PLACE]: 2 })] });
    expect(games.filter((g) => !g.universeKnown).map((g) => g.rootPlaceId)).toEqual([PLACE]);
    expect(work?.work.pendingPlaceIds).toEqual([]);
    expect(work?.work.placeRetries).toBeUndefined();
    expect(logs).toContain(`[INV] place ${PLACE} unresolved after 3 transient attempts · preserved as partial record`);
  });

  it("5xx is treated as transient too", async () => {
    failPlace({ status: 503 });
    const { work } = await runBatch({ nodes: [pendingNode()] });
    expect(work?.work.placeRetries).toEqual({ [PLACE]: 1 });
  });

  it("6. a 429 keeps the place queued via the shared cooldown and does NOT use a retry", async () => {
    failPlace({ status: 429 });
    const { work } = await runBatch({ nodes: [pendingNode({ [PLACE]: 1 })] });
    expect(work?.work.pendingPlaceIds).toContain(PLACE);
    expect(work?.work.placeRetries).toEqual({ [PLACE]: 1 });
  });

  it("7. a throttle deferral does NOT use a retry", async () => {
    failPlace({ status: 429 });
    const { work, checkpoint } = await runBatch({
      nodes: [pendingNode({ [PLACE]: 1 }, [PLACE, 103])],
      // escalation already at level 3: the next 429 opens a 60s cooldown, which outlasts the batch
      throttleState: { cooldownUntil: 0, level: 3, successes: 0, lastThrottleAt: T0 - 1_000 },
    });
    expect(checkpoint.throttleState?.cooldownUntil).toBeGreaterThan(Date.now());
    expect(work?.work.pendingPlaceIds).toEqual([PLACE, 103]);
    expect(work?.work.placeRetries).toEqual({ [PLACE]: 1 });
  });

  it("8. an abort mid-resolution uses no retry: the original work is re-queued untouched", async () => {
    failPlace("abort");
    const { checkpoint } = await runBatch({ nodes: [pendingNode({ [PLACE]: 1 })] });
    expect(checkpoint.reason).toBe("aborted");
    expect(checkpoint.processedUserIds).toEqual([]); // the browser re-queues the node with the work it sent
    expect(checkpoint.nodeResults).toEqual([]);
  });

  it("9. a 404 keeps its terminal behaviour: partial record at once, no retry state", async () => {
    failPlace({ status: 404 });
    const { games, work } = await runBatch({ nodes: [pendingNode()] });
    expect(games.filter((g) => !g.universeKnown).map((g) => g.rootPlaceId)).toEqual([PLACE]);
    expect(work?.work.placeRetries).toBeUndefined();
    expect(work?.work.pendingPlaceIds).toEqual([]);
  });

  it("11. never grows the pending queue past its size (backpressure cap intact)", async () => {
    failPlace("network");
    const full = Array.from({ length: 400 }, (_, i) => (i === 0 ? PLACE : 5_000 + i));
    const { work } = await runBatch({ nodes: [pendingNode(undefined, full)] });
    const pendingAfter = work!.work.pendingPlaceIds!;
    expect(pendingAfter.length).toBe(400 - 15 + 1); // 15 taken, 14 answered, 1 kept for retry
    expect(pendingAfter.at(-1)).toBe(PLACE); // retried places go to the back
    expect(new Set(pendingAfter).size).toBe(pendingAfter.length);
  });
});
