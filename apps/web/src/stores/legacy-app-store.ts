import { createJSONStorage, type StateStorage } from "zustand/middleware";

/** Where the sidebar, the active flow and the Arduino onboarding were persisted
 *  together, before each became its own store under its own key. */
export const LEGACY_APP_KEY = "microflow:app";

/**
 * Local storage for a store split out of {@link LEGACY_APP_KEY}. While the
 * store's own key is absent, the `fields` it owns are moved out of the legacy
 * entry and written under its own key, so a returning user keeps their sidebar,
 * active flow and "already connected" flag (and does not get the
 * first-connection confetti again).
 *
 * Each store takes only its own fields, so they can load in any order; the
 * legacy entry is removed by whichever store takes the last of them. This
 * module can go once returning users have had time to load the app once — one
 * who comes back later only starts from the defaults.
 */
export function splitFromLegacyApp(fields: readonly string[]) {
  return createJSONStorage(() => seededFromLegacyApp(localStorage, fields));
}

/** {@link splitFromLegacyApp} over any `Storage`. */
export function seededFromLegacyApp(storage: Storage, fields: readonly string[]): StateStorage {
  return {
    getItem: (name) => storage.getItem(name) ?? takeLegacyFields(storage, name, fields),
    setItem: (name, value) => storage.setItem(name, value),
    removeItem: (name) => storage.removeItem(name),
  };
}

function takeLegacyFields(storage: Storage, name: string, fields: readonly string[]) {
  const legacy = readLegacy(storage);
  if (!legacy) return null;

  const entries = Object.entries(legacy.state);
  const taken = entries.filter(([field]) => fields.includes(field));
  if (taken.length === 0) return null;

  const value = JSON.stringify({ state: Object.fromEntries(taken), version: legacy.version });
  storage.setItem(name, value);

  const rest = entries.filter(([field]) => !fields.includes(field));
  if (rest.length === 0) storage.removeItem(LEGACY_APP_KEY);
  else storage.setItem(LEGACY_APP_KEY, JSON.stringify({ ...legacy, state: Object.fromEntries(rest) }));

  return value;
}

/** An unreadable legacy entry counts as absent: the store starts from its defaults. */
function readLegacy(storage: Storage): { state: Record<string, unknown>; version?: number } | null {
  const raw = storage.getItem(LEGACY_APP_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.state === "object" && parsed.state !== null ? parsed : null;
  } catch {
    return null;
  }
}
