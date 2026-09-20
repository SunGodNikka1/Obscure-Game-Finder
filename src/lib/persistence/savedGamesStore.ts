"use client";

import type { SavedGameRecord } from "@/lib/savedGames";

/**
 * GLOBAL SAVED GAMES PERSISTENCE (IndexedDB)
 *
 * A deliberately SEPARATE database from the crawl checkpoint (`ogf-crawl`):
 * saving, restoring, discarding or replacing a crawl can never touch this
 * store, and vice versa. One record per universe, keyed by `universeId`.
 *
 * Raw IndexedDB, same pattern as `crawlStore.ts`: no dependency, every call
 * fails soft (resolves `false` / `null`) so a private-mode browser or a
 * blocked store never breaks the finder.
 */

const DB_NAME = "ogf-saved-games";
const DB_VERSION = 1;
const STORE = "games";

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
        database.createObjectStore(STORE, { keyPath: "universeId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** All saved records, or `null` when IndexedDB is unavailable. */
export async function loadSavedGames(): Promise<SavedGameRecord[] | null> {
  const database = await openDb();
  if (!database) return null;
  const value = await new Promise<SavedGameRecord[] | null>((resolve) => {
    try {
      const tx = database.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => {
        const rows = (request.result ?? []) as SavedGameRecord[];
        resolve(rows.filter((row) => row && typeof row.universeId === "number" && row.game));
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  database.close();
  return value;
}

/** Upsert records (one transaction). Resolves `true` only when committed. */
export async function putSavedGames(records: ReadonlyArray<SavedGameRecord>): Promise<boolean> {
  if (records.length === 0) return true;
  const database = await openDb();
  if (!database) return false;
  const ok = await new Promise<boolean>((resolve) => {
    try {
      const tx = database.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const record of records) store.put(record);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
  database.close();
  return ok;
}

/** Remove one save. Resolves `true` when committed (also when it did not exist). */
export async function deleteSavedGame(universeId: number): Promise<boolean> {
  const database = await openDb();
  if (!database) return false;
  const ok = await new Promise<boolean>((resolve) => {
    try {
      const tx = database.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(universeId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
  database.close();
  return ok;
}
