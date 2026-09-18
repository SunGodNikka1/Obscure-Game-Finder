import { CONTINUOUS_CONFIG } from "./config";
import type { UserSourceWork } from "./types";

/**
 * CONTINUOUS INVENTORY BACKPRESSURE
 *
 * Extracted as pure functions so the "never lose a place id" invariant is
 * unit-testable and cannot silently regress.
 *
 * The invariant: `inventoryCursor` is NEVER advanced unless every place id
 * returned by that page has been durably represented in crawl state (i.e.
 * appended to `pendingPlaceIds`, which travels in the checkpoint). Rather
 * than capping the queue by dropping entries -- which silently lost ids once
 * `MAX_PENDING_PLACES_PER_USER` was reached -- the crawler applies
 * backpressure: when the queue cannot absorb a whole page it simply does not
 * fetch one this visit. The user is re-queued (pending > 0), the resolver
 * drains `PLACES_RESOLVED_PER_VISIT` ids per visit, and pagination resumes from
 * the UNCHANGED cursor once there is room again.
 */

/** Roblox inventory pages are requested with `limit: 50` (see roblox/inventory.ts). */
export const INVENTORY_PAGE_SIZE = 50;

export interface InventoryPageLike {
  items: ReadonlyArray<{ assetId: number }>;
  nextCursor: string | null;
}

export interface InventoryBackpressureOptions {
  /** Ceiling on queued-but-unresolved places. Default: CONTINUOUS_CONFIG.MAX_PENDING_PLACES_PER_USER. */
  maxPending?: number;
  /** Ids a single page can return. Default: INVENTORY_PAGE_SIZE. */
  pageSize?: number;
  /** Pages fetched per visit. Default: CONTINUOUS_CONFIG.INVENTORY_PAGES_PER_VISIT. */
  pagesPerVisit?: number;
}

export type InventoryWork = Pick<UserSourceWork, "inventoryCursor" | "inventoryDone">;

export interface InventoryVisitResult {
  /** Pages actually fetched this visit. */
  pagesFetched: number;
  /** New (deduplicated) ids appended to the queue this visit. */
  added: number;
  /** True when a fetch was skipped because the queue could not absorb a full page. */
  deferred: boolean;
}

/**
 * True when the pending queue can absorb a whole page without exceeding the
 * ceiling. Fetching is deferred otherwise, so no returned id is ever dropped.
 */
export function hasRoomForInventoryPage(pendingLength: number, options: InventoryBackpressureOptions = {}): boolean {
  const maxPending = options.maxPending ?? CONTINUOUS_CONFIG.MAX_PENDING_PLACES_PER_USER;
  const pageSize = options.pageSize ?? INVENTORY_PAGE_SIZE;
  return pendingLength + pageSize <= maxPending;
}

/**
 * Appends EVERY id from a fetched page (deduplicated) to `pending`, and only
 * then advances the cursor. If Roblox ever returns more rows than `pageSize`
 * the queue may transiently exceed the ceiling; that is preferred to losing ids.
 * Mutates `pending` and `work` in place, mirroring the route's bookkeeping.
 */
export function absorbInventoryPage(pending: number[], work: InventoryWork, page: InventoryPageLike): number {
  const known = new Set(pending);
  let added = 0;
  for (const entry of page.items) {
    if (known.has(entry.assetId)) continue;
    known.add(entry.assetId);
    pending.push(entry.assetId);
    added += 1;
  }
  // Every returned id is now represented in crawl state -> safe to move on.
  work.inventoryCursor = page.nextCursor;
  if (!page.nextCursor) work.inventoryDone = true;
  return added;
}

/**
 * One visit's worth of inventory listing: fetch up to `pagesPerVisit` pages,
 * stopping early when the listing completes or when the queue has no room for
 * another page. Errors from `fetchPage` propagate to the caller unchanged so
 * the route's existing 403 / abort handling keeps working.
 */
export async function advanceInventoryListing(
  work: InventoryWork,
  pending: number[],
  fetchPage: (cursor: string | null | undefined) => Promise<InventoryPageLike>,
  options: InventoryBackpressureOptions = {},
): Promise<InventoryVisitResult> {
  const pagesPerVisit = options.pagesPerVisit ?? CONTINUOUS_CONFIG.INVENTORY_PAGES_PER_VISIT;
  const result: InventoryVisitResult = { pagesFetched: 0, added: 0, deferred: false };

  for (let i = 0; i < pagesPerVisit; i += 1) {
    if (work.inventoryDone) break;
    if (!hasRoomForInventoryPage(pending.length, options)) {
      result.deferred = true;
      break;
    }
    const page = await fetchPage(work.inventoryCursor);
    result.pagesFetched += 1;
    result.added += absorbInventoryPage(pending, work, page);
    if (work.inventoryDone) break;
  }

  return result;
}
