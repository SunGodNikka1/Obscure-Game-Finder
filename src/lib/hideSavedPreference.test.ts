import { describe, expect, it } from "vitest";
import { HIDE_SAVED_KEY, createHideSavedPreference, parseHideSaved } from "./hideSavedPreference";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  let writes = 0;
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes += 1;
      map.set(key, value);
    },
    get writes() {
      return writes;
    },
    raw: (key: string) => map.get(key),
  };
}

describe("parseHideSaved", () => {
  it("accepts only the exact boolean strings", () => {
    expect(parseHideSaved("true")).toBe(true);
    expect(parseHideSaved("false")).toBe(false);
    for (const bad of ["1", "0", "yes", "TRUE", " true", "", null, undefined, "{}", "null"]) {
      expect(parseHideSaved(bad)).toBeNull();
    }
  });
});

describe("hide-saved preference persistence", () => {
  it("stored true restores as true", () => {
    const pref = createHideSavedPreference(() => fakeStorage({ [HIDE_SAVED_KEY]: "true" }));
    expect(pref.hydrate()).toBe(true);
  });

  it("stored false restores as false", () => {
    const pref = createHideSavedPreference(() => fakeStorage({ [HIDE_SAVED_KEY]: "false" }));
    expect(pref.hydrate()).toBe(false);
  });

  it("toggling writes the preference", () => {
    const storage = fakeStorage();
    const pref = createHideSavedPreference(() => storage);
    pref.hydrate();
    expect(pref.persist(true)).toBe(true);
    expect(storage.raw(HIDE_SAVED_KEY)).toBe("true");
    expect(pref.persist(false)).toBe(true);
    expect(storage.raw(HIDE_SAVED_KEY)).toBe("false");
  });

  it("first initialization never clobbers an existing stored true with the default false", () => {
    const storage = fakeStorage({ [HIDE_SAVED_KEY]: "true" });
    const pref = createHideSavedPreference(() => storage);
    // the component's initial state is false; a persist before hydration must be ignored
    expect(pref.persist(false)).toBe(false);
    expect(storage.raw(HIDE_SAVED_KEY)).toBe("true");
    expect(pref.hydrate()).toBe(true);
    // re-persisting the restored value is a no-op, not a rewrite
    expect(pref.persist(true)).toBe(false);
    expect(storage.writes).toBe(0);
    // only a genuine change after hydration writes
    expect(pref.persist(false)).toBe(true);
    expect(storage.raw(HIDE_SAVED_KEY)).toBe("false");
  });

  it("malformed or missing storage safely falls back to false", () => {
    expect(createHideSavedPreference(() => fakeStorage({ [HIDE_SAVED_KEY]: "yes" })).hydrate()).toBe(false);
    expect(createHideSavedPreference(() => fakeStorage()).hydrate()).toBe(false);
    expect(createHideSavedPreference(() => null).hydrate()).toBe(false);
    expect(
      createHideSavedPreference(() => {
        throw new Error("SecurityError: storage disabled");
      }).hydrate(),
    ).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error("boom");
      },
      setItem: () => {
        throw new Error("boom");
      },
    };
    const pref = createHideSavedPreference(() => throwing);
    expect(pref.hydrate()).toBe(false);
    expect(pref.persist(true)).toBe(false); // failure is swallowed, the UI keeps working
  });

  it("does not persist a missing value as false just by hydrating", () => {
    const storage = fakeStorage();
    const pref = createHideSavedPreference(() => storage);
    pref.hydrate();
    expect(pref.persist(false)).toBe(false); // unchanged from the (absent -> false) hydrated value
    expect(storage.writes).toBe(0);
  });
});
