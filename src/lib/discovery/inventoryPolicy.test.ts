import { describe, expect, it } from "vitest";
import { CONTINUOUS_CONFIG } from "./config";
import {
  INVENTORY_PAGE_SIZE,
  absorbInventoryPage,
  advanceInventoryListing,
  hasRoomForInventoryPage,
  type InventoryPageLike,
  type InventoryWork,
} from "./inventoryPolicy";

const MAX = CONTINUOUS_CONFIG.MAX_PENDING_PLACES_PER_USER; // 400
const PAGE = INVENTORY_PAGE_SIZE; // 50
const DRAIN = CONTINUOUS_CONFIG.PLACES_RESOLVED_PER_VISIT; // 15

/** Deterministic fake inventory: `total` unique place ids split into 50-item pages. */
function fakeInventory(total: number, pageSize = PAGE) {
  const ids = Array.from({ length: total }, (_, i) => 1_000_000 + i);
  const pages: InventoryPageLike[] = [];
  for (let start = 0; start < total; start += pageSize) {
    const slice = ids.slice(start, start + pageSize);
    const pageIndex = start / pageSize;
    const isLast = start + pageSize >= total;
    pages.push({ items: slice.map((assetId) => ({ assetId })), nextCursor: isLast ? null : `c${pageIndex + 1}` });
  }
  const cursorToIndex = (cursor: string | null | undefined) => (cursor ? Number(cursor.slice(1)) : 0);
  const fetches: Array<string | null | undefined> = [];
  const fetchPage = async (cursor: string | null | undefined) => {
    fetches.push(cursor);
    return pages[cursorToIndex(cursor)];
  };
  return { ids, pages, fetchPage, fetches };
}

function page(count: number, nextCursor: string | null, offset = 0): InventoryPageLike {
  return { items: Array.from({ length: count }, (_, i) => ({ assetId: 5_000 + offset + i })), nextCursor };
}

describe("hasRoomForInventoryPage", () => {
  it("allows a fetch only when a whole page fits under the ceiling", () => {
    expect(hasRoomForInventoryPage(0)).toBe(true);
    expect(hasRoomForInventoryPage(MAX - PAGE)).toBe(true); // 350 + 50 == 400
    expect(hasRoomForInventoryPage(MAX - PAGE + 1)).toBe(false); // 351 + 50 > 400
    expect(hasRoomForInventoryPage(MAX)).toBe(false);
  });

  it("respects custom limits", () => {
    expect(hasRoomForInventoryPage(10, { maxPending: 20, pageSize: 10 })).toBe(true);
    expect(hasRoomForInventoryPage(11, { maxPending: 20, pageSize: 10 })).toBe(false);
  });
});

describe("absorbInventoryPage", () => {
  it("appends every id, then advances the cursor", () => {
    const pending: number[] = [1, 2];
    const work: InventoryWork = { inventoryCursor: "c0" };
    const added = absorbInventoryPage(pending, work, page(3, "c1"));
    expect(added).toBe(3);
    expect(pending).toEqual([1, 2, 5_000, 5_001, 5_002]);
    expect(work.inventoryCursor).toBe("c1");
    expect(work.inventoryDone).toBeUndefined();
  });

  it("marks the listing done when the page has no next cursor", () => {
    const work: InventoryWork = { inventoryCursor: "c3" };
    absorbInventoryPage([], work, page(2, null));
    expect(work.inventoryCursor).toBeNull();
    expect(work.inventoryDone).toBe(true);
  });

  it("deduplicates against the queue and within the page without dropping new ids", () => {
    const pending: number[] = [5_000];
    const work: InventoryWork = {};
    const dup: InventoryPageLike = { items: [{ assetId: 5_000 }, { assetId: 5_001 }, { assetId: 5_001 }, { assetId: 5_002 }], nextCursor: null };
    expect(absorbInventoryPage(pending, work, dup)).toBe(2);
    expect(pending).toEqual([5_000, 5_001, 5_002]);
  });

  it("never drops ids even if a page is larger than the remaining room", () => {
    // The fetch decision is what enforces the ceiling; once a page HAS been
    // fetched every id on it must be kept so the cursor can advance safely.
    const pending = Array.from({ length: MAX - PAGE }, (_, i) => i); // 350, exactly enough room for 50
    const work: InventoryWork = { inventoryCursor: "c0" };
    absorbInventoryPage(pending, work, page(60, "c1")); // Roblox returned more than expected
    expect(pending.length).toBe(MAX - PAGE + 60); // 410: transiently over the ceiling, nothing lost
    expect(work.inventoryCursor).toBe("c1");
  });
});

describe("advanceInventoryListing (per-visit backpressure)", () => {
  it("queue nearly full + 50-item page: does not fetch, loses nothing, keeps the cursor", async () => {
    const pending = Array.from({ length: MAX - PAGE + 1 }, (_, i) => i); // 351: a full page would overflow
    const snapshot = [...pending];
    const work: InventoryWork = { inventoryCursor: "c7", inventoryDone: false };
    let calls = 0;
    const fetchPage = async () => {
      calls += 1;
      return page(PAGE, "c8");
    };

    const result = await advanceInventoryListing(work, pending, fetchPage);

    expect(calls).toBe(0);
    expect(result).toEqual({ pagesFetched: 0, added: 0, deferred: true });
    expect(pending).toEqual(snapshot);
    expect(work.inventoryCursor).toBe("c7"); // cursor preserved for a later visit
    expect(work.inventoryDone).toBe(false);
  });

  it("queue with exactly one page of room: fetches and appends all 50 ids", async () => {
    const pending = Array.from({ length: MAX - PAGE }, (_, i) => i); // 350
    const work: InventoryWork = { inventoryCursor: "c7" };
    const result = await advanceInventoryListing(work, pending, async () => page(PAGE, "c8"));
    expect(result).toEqual({ pagesFetched: 1, added: PAGE, deferred: false });
    expect(pending.length).toBe(MAX);
    expect(work.inventoryCursor).toBe("c8");
  });

  it("fetches from the stored cursor (undefined on the very first visit)", async () => {
    const seen: Array<string | null | undefined> = [];
    const work: InventoryWork = {};
    await advanceInventoryListing(work, [], async (cursor) => {
      seen.push(cursor);
      return page(3, null);
    });
    expect(seen).toEqual([undefined]);
    expect(work.inventoryDone).toBe(true);
  });

  it("does nothing once the listing is complete", async () => {
    let calls = 0;
    const result = await advanceInventoryListing({ inventoryDone: true, inventoryCursor: null }, [], async () => {
      calls += 1;
      return page(1, null);
    });
    expect(calls).toBe(0);
    expect(result.pagesFetched).toBe(0);
  });

  it("propagates fetch errors without touching cursor or queue", async () => {
    const pending = [1, 2, 3];
    const work: InventoryWork = { inventoryCursor: "c2" };
    await expect(
      advanceInventoryListing(work, pending, async () => {
        throw new Error("HTTP 403");
      }),
    ).rejects.toThrow("HTTP 403");
    expect(pending).toEqual([1, 2, 3]);
    expect(work.inventoryCursor).toBe("c2");
    expect(work.inventoryDone).toBeUndefined();
  });

  it("with several pages per visit, re-checks room between pages", async () => {
    const pending = Array.from({ length: MAX - PAGE * 2 + 1 }, (_, i) => i); // 301: room for one page, not two
    const work: InventoryWork = {};
    let n = 0;
    const result = await advanceInventoryListing(
      work,
      pending,
      async () => page(PAGE, `c${++n}`, n * PAGE),
      { pagesPerVisit: 3 },
    );
    expect(result.pagesFetched).toBe(1);
    expect(result.deferred).toBe(true);
    expect(pending.length).toBe(MAX - PAGE * 2 + 1 + PAGE);
    expect(work.inventoryCursor).toBe("c1");
  });

  it("drains, resumes pagination from the unchanged cursor, and eventually completes with no id lost", async () => {
    // A 1 000-place inventory (20 pages) is far larger than the 400-id ceiling,
    // so backpressure MUST engage. Each simulated visit mirrors the route:
    //   1. advanceInventoryListing (fetch if there is room)
    //   2. splice PLACES_RESOLVED_PER_VISIT ids off the queue and "resolve" them
    const inventory = fakeInventory(1_000);
    const work: InventoryWork = {};
    const pending: number[] = [];
    const resolved: number[] = [];
    let deferredVisits = 0;
    let maxQueue = 0;
    let visits = 0;

    while (!work.inventoryDone || pending.length > 0) {
      visits += 1;
      if (visits > 10_000) throw new Error("did not converge");

      const visit = await advanceInventoryListing(work, pending, inventory.fetchPage);
      if (visit.deferred) deferredVisits += 1;
      maxQueue = Math.max(maxQueue, pending.length);

      resolved.push(...pending.splice(0, DRAIN));
    }

    // Backpressure actually engaged and the queue never exceeded the ceiling.
    expect(deferredVisits).toBeGreaterThan(0);
    expect(maxQueue).toBeLessThanOrEqual(MAX);

    // Pagination resumed from the unchanged cursor: every page was fetched
    // exactly once, in order, despite the deferrals in between.
    expect(inventory.fetches).toEqual([undefined, ...inventory.pages.slice(0, -1).map((_, i) => `c${i + 1}`)]);

    // Nothing lost, nothing duplicated, listing complete, queue drained.
    expect(resolved.length).toBe(inventory.ids.length);
    expect([...resolved].sort((a, b) => a - b)).toEqual(inventory.ids);
    expect(new Set(resolved).size).toBe(inventory.ids.length);
    expect(work.inventoryDone).toBe(true);
    expect(work.inventoryCursor).toBeNull();
    expect(pending).toEqual([]);
  });

  it("(regression) the previous drop-on-full behaviour would have lost ids under the same load", () => {
    // Documents WHY the invariant exists: appending only while `length < MAX`
    // and advancing the cursor regardless discards the tail of a page.
    const pending = Array.from({ length: MAX - 10 }, (_, i) => i); // 390
    const incoming = page(PAGE, "c9");
    const before = pending.length;
    for (const entry of incoming.items) {
      if (pending.length < MAX && !pending.includes(entry.assetId)) pending.push(entry.assetId);
    }
    const kept = pending.length - before;
    expect(kept).toBe(10);
    expect(PAGE - kept).toBe(40); // 40 ids silently gone once the cursor moved on
  });
});
