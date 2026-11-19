import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
// A local session persists through y-indexeddb; bun's test runner provides no
// `indexedDB`. Import the shim here so this file does not depend on another
// test file having installed one.
import "fake-indexeddb/auto";
import {
  __peekRegistry,
  __resetRegistry,
  acquireLocalSession,
  acquireSession,
  peekSession,
  releaseSession,
} from "./session-registry";
import { createLocalSession, provideHandleSets } from "./flow-session";

afterEach(() => {
  __resetRegistry();
});

// These sessions are not about handle pruning. A writable session without
// handle sets reports the missing wiring, so give them one that knows no node.
beforeAll(() => provideHandleSets(() => null));
afterAll(() => provideHandleSets(null));

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

describe("SessionRegistry render-time peek", () => {
  test("a session built by a render that never commits is reclaimed", async () => {
    peekSession("local", createLocalSession, 20);
    expect(__peekRegistry("local")?.refs).toBe(0);

    await sleep(40);
    expect(__peekRegistry("local")).toBeUndefined();
  });

  test("the effect's acquire claims the peeked session and cancels its reclaim", async () => {
    const peeked = peekSession("local", createLocalSession, 20);
    const held = acquireSession("local", createLocalSession);
    expect(held).toBe(peeked);
    expect(__peekRegistry("local")?.refs).toBe(1);

    await sleep(40);
    expect(__peekRegistry("local")?.session).toBe(peeked);
  });

  test("render peeks take no references, so a double render cannot leak one", () => {
    peekSession("local", createLocalSession);
    peekSession("local", createLocalSession);
    // Strict Mode's effect cycle: acquire, release, acquire.
    acquireSession("local", createLocalSession);
    releaseSession("local");
    acquireSession("local", createLocalSession);
    expect(__peekRegistry("local")?.refs).toBe(1);
    // The real unmount brings it to zero and schedules the destroy.
    releaseSession("local");
    expect(__peekRegistry("local")?.refs).toBe(0);
    expect(__peekRegistry("local")?.pendingDestroy).not.toBeNull();
  });
});
