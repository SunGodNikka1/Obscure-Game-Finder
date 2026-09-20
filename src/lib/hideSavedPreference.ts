/**
 * "Hide saved games" is a tiny browser UI preference (not crawl data, not the
 * Saved Games collection), so it lives in localStorage under one namespaced
 * key. Only this one flag is persisted; the rest of FilterState is not.
 *
 * The controller has a hydration gate: `persist()` is ignored until
 * `hydrate()` has read the stored value, so the component's default
 * (`false`) can never overwrite a stored `true` during initial render.
 */
export const HIDE_SAVED_KEY = "ogf.hideSaved";

/** The subset of the Web Storage API we use; injectable for tests. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Accept only the exact boolean representations; anything else is "not set". */
export function parseHideSaved(raw: string | null | undefined): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export interface HideSavedPreference {
  /** Read the stored value (false when missing, malformed or storage unavailable). Enables persisting. */
  hydrate(): boolean;
  /** Write a new value. No-op before hydrate(), when unchanged, or when storage is unavailable. Returns true when written. */
  persist(value: boolean): boolean;
  readonly hydrated: boolean;
}

export function createHideSavedPreference(getStorage: () => KeyValueStorage | null | undefined): HideSavedPreference {
  let hydrated = false;
  let last: boolean | null = null;

  const storage = (): KeyValueStorage | null => {
    try {
      return getStorage() ?? null;
    } catch {
      return null;
    }
  };

  return {
    get hydrated() {
      return hydrated;
    },
    hydrate() {
      hydrated = true;
      let value: boolean | null = null;
      try {
        value = parseHideSaved(storage()?.getItem(HIDE_SAVED_KEY));
      } catch {
        value = null;
      }
      // Absent / malformed counts as false, so the first ready render does
      // not write the default back: only a genuine change is persisted.
      last = value ?? false;
      return last;
    },
    persist(value: boolean) {
      if (!hydrated || value === last) return false;
      try {
        const target = storage();
        if (!target) return false;
        target.setItem(HIDE_SAVED_KEY, value ? "true" : "false");
        last = value;
        return true;
      } catch {
        return false;
      }
    },
  };
}
