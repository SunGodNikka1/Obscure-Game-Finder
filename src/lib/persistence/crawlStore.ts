"use client";

import type { DiscoveredGame, FrontierNode } from "@/lib/discovery/types";
import type { SerializedBudgetState } from "@/lib/roblox/budget";

/**
 * CONTINUOUS ∞ CRAWL PERSISTENCE (IndexedDB)
 *
 * An archaeology crawl can run for hours. Keeping the frontier only in React
 * refs means a browser refresh, tab crash or accidental navigation destroys it.
 * This module persists the whole recoverable checkpoint to IndexedDB after
 * every committed batch.
 *
 * On reload the app DETECTS the saved crawl and offers "Resume" / "Discard".
 * It never resumes network activity on its own.
 *
 * Raw IndexedDB is used deliberately: no extra dependency, and the payload is a
 * single structured-cloneable record per store.
 */

const DB_NAME = "ogf-crawl";
const DB_VERSION = 1;
const STORE = "checkpoint";
const CHECKPOINT_KEY = "continuous";

export interface PersistedCrawl {
  version: 1;
  savedAt: number;
  /** Starting username for the crawl. */
  username: string;
  target: { userId: number; username: string; displayName: string } | null;
  sources: { includeCreated: boolean; includeFavorites: boolean; includeInventory: boolean };
  frontier: FrontierNode[];
  /** Users already enqueued or scanned (loop prevention). */
  seenUserIds: number[];
  /** Users whose work finished at least one visit. */
  completedUserIds: number[];
  /** userId -> [parentUserId | null, username] for path reconstruction. */
  parentMap: Array<[number, [number | null, string]]>;
  budgetState: SerializedBudgetState | null;
  maxDepthReached: number;
  batchNumber: number;
  cumulative: {
    usersScanned: number;
    friendsFound: number;
    requestsMade: number;
    playable: number;
    closed: number;
  };
  games: DiscoveredGame[];
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export async function saveCrawl(state: PersistedCrawl): Promise<void> {
  const database = await openDb();
  if (!database) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = database.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(state, CHECKPOINT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  database.close();
}

export async function loadCrawl(): Promise<PersistedCrawl | null> {
  const database = await openDb();
  if (!database) return null;
  const value = await new Promise<PersistedCrawl | null>((resolve) => {
    try {
      const tx = database.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(CHECKPOINT_KEY);
      request.onsuccess = () => {
        const result = request.result as PersistedCrawl | undefined;
        resolve(result && result.version === 1 ? result : null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  database.close();
  return value;
}

export async function clearCrawl(): Promise<void> {
  const database = await openDb();
  if (!database) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = database.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(CHECKPOINT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  database.close();
}
