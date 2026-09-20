"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiscoveredGame } from "@/lib/discovery/types";
import { deleteSavedGame, loadSavedGames, putSavedGames } from "@/lib/persistence/savedGamesStore";
import {
  LEGACY_SAVED_KEYS,
  makeSavedRecord,
  parseLegacySavedIds,
  planLegacyImport,
  reconcileSaved,
  sortSavedRecords,
  type SavedGameRecord,
} from "@/lib/savedGames";

/**
 * Global Saved Games (◆) -- independent of any crawl.
 *
 * - Loaded once from IndexedDB on mount (never from crawl state).
 * - Legacy per-session id lists in sessionStorage are imported ONCE, without
 *   duplicates, and only removed after the import has been committed.
 * - Whenever a saved universe shows up again (current pool, or the games of
 *   a recoverable checkpoint) its snapshot is refreshed in place; the save
 *   itself is never dropped or duplicated.
 * - When IndexedDB is unavailable the collection still works for the session
 *   and mirrors its ids to sessionStorage, like the previous implementation.
 */
export function useSavedGames(pool: ReadonlyArray<DiscoveredGame>, checkpointGames?: ReadonlyArray<DiscoveredGame>) {
  const [records, setRecords] = useState<Map<number, SavedGameRecord>>(() => new Map());
  const [ready, setReady] = useState(false);
  const idbRef = useRef<boolean | null>(null);
  const recordsRef = useRef(records);
  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  // ---- load + migrate (once) ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadSavedGames();
      if (cancelled) return;
      idbRef.current = stored !== null;
      const next = new Map<number, SavedGameRecord>();
      for (const record of stored ?? []) next.set(record.universeId, record);

      // One-way import of the pre-global sessionStorage id lists.
      let legacyIds: number[] = [];
      try {
        legacyIds = LEGACY_SAVED_KEYS.flatMap((key) => parseLegacySavedIds(window.sessionStorage.getItem(key)));
      } catch {
        /* storage unavailable */
      }
      const imported = planLegacyImport(next, legacyIds, () => undefined);
      for (const record of imported) next.set(record.universeId, record);
      if (imported.length > 0 && stored !== null) {
        const committed = await putSavedGames(imported);
        if (committed) {
          try {
            for (const key of LEGACY_SAVED_KEYS) window.sessionStorage.removeItem(key);
          } catch {
            /* ignore */
          }
        }
      }
      if (cancelled) return;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async hydration from IndexedDB
      setRecords(next);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- reconcile: fresher metadata from the pool / a recoverable checkpoint ----
  useEffect(() => {
    if (!ready || records.size === 0) return;
    const sources = checkpointGames && checkpointGames.length > 0 ? [...checkpointGames, ...pool] : pool;
    const changed = reconcileSaved(records, sources);
    if (changed.length === 0) return;
    const next = new Map(records);
    for (const record of changed) next.set(record.universeId, record);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refreshing stored snapshots from an external store
    setRecords(next);
    if (idbRef.current) void putSavedGames(changed);
  }, [ready, records, pool, checkpointGames]);

  // ---- fallback mirror when IndexedDB is unavailable ----
  useEffect(() => {
    if (!ready || idbRef.current !== false) return;
    try {
      window.sessionStorage.setItem(LEGACY_SAVED_KEYS[0], JSON.stringify(Array.from(records.keys())));
    } catch {
      /* ignore quota / privacy mode */
    }
  }, [ready, records]);

  const toggleSave = useCallback((game: DiscoveredGame) => {
    const current = recordsRef.current;
    const next = new Map(current);
    if (next.has(game.universeId)) {
      next.delete(game.universeId);
      if (idbRef.current) void deleteSavedGame(game.universeId);
    } else {
      const record = makeSavedRecord(game);
      next.set(game.universeId, record);
      if (idbRef.current) void putSavedGames([record]);
    }
    recordsRef.current = next;
    setRecords(next);
  }, []);

  const savedIds = useMemo<ReadonlySet<number>>(() => new Set(records.keys()), [records]);
  const savedGames = useMemo(() => sortSavedRecords(records.values()).map((record) => record.game), [records]);

  return { ready, records, savedIds, savedGames, toggleSave };
}
