import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { LEGACY_APP_KEY, seededFromLegacyApp } from "./legacy-app-store";

/** bun has no `localStorage`; this is just enough of one. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => void items.delete(key),
    setItem: (key: string, value: string) => void items.set(key, String(value)),
  };
}

const persisted = (state: Record<string, unknown>) => JSON.stringify({ state, version: 0 });
const read = (storage: Storage, key: string) => JSON.parse(storage.getItem(key) ?? "null");

/** What `microflow:app` holds for a user who has used the app before. */
const RETURNING_USER = { sidebarOpen: false, activeFlowId: "flow-1", hasConnectedArduino: true };

describe("seededFromLegacyApp", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("moves the store's fields from the legacy entry to its own key", () => {
    storage.setItem(LEGACY_APP_KEY, persisted(RETURNING_USER));

    const value = seededFromLegacyApp(storage, ["sidebarOpen"]).getItem("microflow:sidebar");

    expect(JSON.parse(value as string)).toEqual({ state: { sidebarOpen: false }, version: 0 });
    expect(storage.getItem("microflow:sidebar")).toBe(value as string);
    expect(read(storage, LEGACY_APP_KEY)).toEqual({
      state: { activeFlowId: "flow-1", hasConnectedArduino: true },
      version: 0,
    });
  });

  it("removes the legacy entry once its last field has moved, in any order", () => {
    storage.setItem(LEGACY_APP_KEY, persisted(RETURNING_USER));

    seededFromLegacyApp(storage, ["hasConnectedArduino"]).getItem("microflow:arduino-onboarding");
    seededFromLegacyApp(storage, ["sidebarOpen"]).getItem("microflow:sidebar");
    expect(storage.getItem(LEGACY_APP_KEY)).not.toBeNull();

    seededFromLegacyApp(storage, ["activeFlowId"]).getItem("microflow:active-flow");
    expect(storage.getItem(LEGACY_APP_KEY)).toBeNull();
    expect(read(storage, "microflow:active-flow").state).toEqual({ activeFlowId: "flow-1" });
  });

  it("prefers the store's own key and leaves the legacy entry alone", () => {
    storage.setItem(LEGACY_APP_KEY, persisted(RETURNING_USER));
    storage.setItem("microflow:sidebar", persisted({ sidebarOpen: true }));

    const value = seededFromLegacyApp(storage, ["sidebarOpen"]).getItem("microflow:sidebar");

    expect(JSON.parse(value as string).state).toEqual({ sidebarOpen: true });
    expect(read(storage, LEGACY_APP_KEY).state).toEqual(RETURNING_USER);
  });

  it("finds nothing for a new user", () => {
    expect(seededFromLegacyApp(storage, ["sidebarOpen"]).getItem("microflow:sidebar")).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("finds nothing when the legacy entry lacks the store's fields", () => {
    storage.setItem(LEGACY_APP_KEY, persisted({ sidebarOpen: false }));

    expect(seededFromLegacyApp(storage, ["activeFlowId"]).getItem("microflow:active-flow")).toBeNull();
    expect(storage.getItem("microflow:active-flow")).toBeNull();
    expect(read(storage, LEGACY_APP_KEY).state).toEqual({ sidebarOpen: false });
  });

  it("treats an unreadable legacy entry as absent", () => {
    storage.setItem(LEGACY_APP_KEY, "{not json");

    expect(seededFromLegacyApp(storage, ["sidebarOpen"]).getItem("microflow:sidebar")).toBeNull();
    expect(storage.getItem("microflow:sidebar")).toBeNull();
  });
});

describe("the stores split out of microflow:app", () => {
  const storage = memoryStorage();
  // Bun runs every test file in one process, and a DOM test (happy-dom) can leave
  // `localStorage` behind as a read-only accessor, so plain assignment would throw.
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let sidebar: typeof import("./sidebar");
  let activeFlow: typeof import("./active-flow");
  let onboarding: typeof import("./arduino-onboarding");

  beforeAll(async () => {
    storage.setItem(LEGACY_APP_KEY, persisted(RETURNING_USER));
    // Left behind by an earlier active-flow store; must not win over the legacy entry.
    storage.setItem("microflow-active-flow", persisted({ activeFlowId: "stale" }));
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
    // Imported only now: each store picks up `localStorage` as it is created.
    sidebar = await import("./sidebar");
    activeFlow = await import("./active-flow");
    onboarding = await import("./arduino-onboarding");
  });

  afterAll(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("restore a returning user's state from the legacy key", () => {
    expect(sidebar.useSidebarStore.getState().sidebarOpen).toBe(false);
    expect(activeFlow.useActiveFlowStore.getState().activeFlowId).toBe("flow-1");
    expect(onboarding.useArduinoOnboardingStore.getState().hasConnectedArduino).toBe(true);
    expect(onboarding.useArduinoOnboardingStore.getState().showConfetti).toBe(false);
  });

  it("each persist under their own key, and the legacy key is gone", () => {
    expect(storage.getItem(LEGACY_APP_KEY)).toBeNull();
    expect(read(storage, "microflow:sidebar")).toEqual({ state: { sidebarOpen: false }, version: 0 });
    expect(read(storage, "microflow:active-flow")).toEqual({ state: { activeFlowId: "flow-1" }, version: 0 });
    expect(read(storage, "microflow:arduino-onboarding")).toEqual({
      state: { hasConnectedArduino: true },
      version: 0,
    });
  });

  it("persist changes, but never the confetti", () => {
    sidebar.useSidebarStore.getState().toggleSidebar();
    activeFlow.useActiveFlowStore.getState().setActiveFlowId("flow-2");
    onboarding.useArduinoOnboardingStore.getState().markArduinoConnected();

    expect(onboarding.useArduinoOnboardingStore.getState().showConfetti).toBe(true);
    expect(read(storage, "microflow:sidebar").state).toEqual({ sidebarOpen: true });
    expect(read(storage, "microflow:active-flow").state).toEqual({ activeFlowId: "flow-2" });
    expect(read(storage, "microflow:arduino-onboarding").state).toEqual({ hasConnectedArduino: true });
  });
});
