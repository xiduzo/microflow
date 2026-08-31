import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __peekRegistry,
  __resetRegistry,
  acquireLocalSession,
  releaseSession,
} from "../session-registry";

// A local session builds a `LocalStorageSyncAdapter`, which reads and writes
// `localStorage` — a global bun's test runner does not provide. Install one per
// test and remove it after, so this file neither depends on another test file
// having installed one nor leaves one behind for the next.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
});

afterEach(() => {
  __resetRegistry();
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SessionRegistry", () => {
  test("acquire creates a session with refs=1", () => {
    const session = acquireLocalSession();
    expect(session).toBeDefined();
    expect(__peekRegistry("local")?.refs).toBe(1);
  });

  test("second acquire returns the same instance and bumps refs", () => {
    const a = acquireLocalSession();
    const b = acquireLocalSession();
    expect(a).toBe(b);
    expect(__peekRegistry("local")?.refs).toBe(2);
  });

  test("release decrements refs without destroying immediately", () => {
    acquireLocalSession();
    acquireLocalSession();
    releaseSession("local");
    const entry = __peekRegistry("local");
    expect(entry?.refs).toBe(1);
    expect(entry?.pendingDestroy).toBeNull();
  });

  test("release to zero schedules destroy via grace period", async () => {
    acquireLocalSession();
    releaseSession("local");
    expect(__peekRegistry("local")?.pendingDestroy).not.toBeNull();
    expect(__peekRegistry("local")).toBeDefined();

    await sleep(150);
    expect(__peekRegistry("local")).toBeUndefined();
  });

  test("acquire within grace period cancels destroy and reuses instance", async () => {
    const first = acquireLocalSession();
    releaseSession("local");
    expect(__peekRegistry("local")?.pendingDestroy).not.toBeNull();

    await sleep(50);

    const second = acquireLocalSession();
    expect(second).toBe(first);
    expect(__peekRegistry("local")?.pendingDestroy).toBeNull();
    expect(__peekRegistry("local")?.refs).toBe(1);

    await sleep(200);
    expect(__peekRegistry("local")).toBeDefined();
  });

  test("Strict Mode double-mount sequence reuses the same instance", async () => {
    // Simulates mount → unmount → mount within React 18 Strict Mode
    const first = acquireLocalSession();
    releaseSession("local");
    const second = acquireLocalSession();
    expect(second).toBe(first);
    expect(__peekRegistry("local")?.refs).toBe(1);
  });

  test("release of unknown flowId is a no-op", () => {
    expect(() => releaseSession("never-acquired")).not.toThrow();
  });
});
