import { describe, expect, test } from "bun:test";
import { RuntimeBridge, type FlowRuntimeCalls, type RuntimeFault } from "./runtime-bridge";
import { pumpReader } from "./web-serial";
import type { FirmataSession } from "./wasm";

// ADR-0017: a wasm fault is never transport news. Two halves prove it, matching
// the two places the old behaviour leaked:
//
//   1. `RuntimeBridge` contains the throw and classifies it, so nothing unwinds
//      into the caller (the serial read loop, or a bare `setTimeout`).
//   2. `pumpReader` treats only a failing `reader.read()` as the port going
//      away, so `onClosed` — and therefore auto-reconnect — stays reachable only
//      from genuine transport loss.
//
// Both run without wasm, without a serial port and without React: the bridge
// takes a structural `FlowRuntimeCalls`, and the pump takes a structural reader.

const NO_EFFECTS = JSON.stringify({
  outboundBytes: [],
  componentEvents: [],
  wakeups: [],
  cancellations: [],
  cloudRequests: [],
  nodeDiagnostics: [],
});

/** A runtime double whose `feedBytes` throws whatever it is handed. */
function throwingRuntime(error: unknown): { runtime: FlowRuntimeCalls; calls: () => number } {
  let calls = 0;
  const unused = () => {
    throw new Error("not exercised by this test");
  };
  const runtime = {
    setPins: unused,
    updateFlow: unused,
    wake: (nodeId: string) => {
      calls += 1;
      void nodeId;
      throw error;
    },
    feedBytes: () => {
      calls += 1;
      throw error;
    },
    injectEvent: unused,
    deliverMessage: unused,
    reconcileSubscriptions: unused,
    midiListeners: unused,
  } as unknown as FlowRuntimeCalls;
  return { runtime, calls: () => calls };
}

describe("RuntimeBridge (ADR-0017)", () => {
  test("a throwing feedBytes is contained and classified, never rethrown", () => {
    const faults: RuntimeFault[] = [];
    const { runtime } = throwingRuntime(new Error("bad sysex length"));
    const bridge = new RuntimeBridge(runtime, (fault) => faults.push(fault));

    // The call site (the serial read loop) sees a value, not an exception.
    const result = bridge.call("feedBytes", null, (rt) => rt.feedBytes(new Uint8Array([1]), 0));

    expect(result).toBeUndefined();
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ kind: "badInput", op: "feedBytes", node: null });
    // A rejected input leaves the engine usable — this is not a dead module.
    expect(bridge.live).toBe(true);
  });

  test("a rejected input keeps the runtime callable", () => {
    const faults: RuntimeFault[] = [];
    let feeds = 0;
    const runtime = {
      feedBytes: () => {
        feeds += 1;
        if (feeds === 1) throw new Error("bad sysex length");
        return NO_EFFECTS;
      },
    } as unknown as FlowRuntimeCalls;
    const bridge = new RuntimeBridge(runtime, (fault) => faults.push(fault));

    bridge.call("feedBytes", null, (rt) => rt.feedBytes(new Uint8Array([1]), 0));
    const second = bridge.call("feedBytes", null, (rt) => rt.feedBytes(new Uint8Array([2]), 0));

    expect(second).toBe(NO_EFFECTS);
    expect(feeds).toBe(2);
    expect(faults).toHaveLength(1);
  });

  test("a wasm trap poisons the bridge: the runtime stops being called", () => {
    const faults: RuntimeFault[] = [];
    const trap = new WebAssembly.RuntimeError("unreachable executed");
    const { runtime, calls } = throwingRuntime(trap);
    const bridge = new RuntimeBridge(runtime, (fault) => faults.push(fault));

    for (let i = 0; i < 50; i += 1) {
      bridge.call("feedBytes", null, (rt) => rt.feedBytes(new Uint8Array([i]), 0));
    }

    // The module was entered exactly once; the latch dropped the other 49.
    expect(calls()).toBe(1);
    expect(bridge.live).toBe(false);
    expect(faults[0]).toMatchObject({ kind: "engineBroken", op: "feedBytes" });
    // One `engineBroken`, then at most one "already closed" note — not 50 faults.
    expect(faults.filter((f) => f.kind === "engineBroken")).toHaveLength(1);
    expect(faults.length).toBeLessThanOrEqual(2);
  });

  test("an op that carries a node attributes the fault to it", () => {
    const faults: RuntimeFault[] = [];
    const { runtime } = throwingRuntime(new Error("no such method"));
    const bridge = new RuntimeBridge(runtime, (fault) => faults.push(fault));

    bridge.call("wake", "osc-1", (rt) => rt.wake("osc-1", "_tick", 0));

    expect(faults[0]).toMatchObject({ kind: "badInput", op: "wake", node: "osc-1" });
  });

  test("a disposed bridge never re-enters wasm and stays quiet", () => {
    const faults: RuntimeFault[] = [];
    const { runtime, calls } = throwingRuntime(new Error("unused"));
    const bridge = new RuntimeBridge(runtime, (fault) => faults.push(fault));
    bridge.dispose();

    bridge.call("feedBytes", null, (rt) => rt.feedBytes(new Uint8Array([1]), 0));

    expect(calls()).toBe(0);
    expect(faults).toEqual([]);
  });
});

// --- The transport half -----------------------------------------------------

/** A reader that yields queued chunks, then blocks until `end()` / `fail()`. */
function fakeReader(chunks: Uint8Array[]) {
  const queue = [...chunks];
  let settle: (result: { value?: Uint8Array; done: boolean }) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const pending = new Promise<{ value?: Uint8Array; done: boolean }>((resolve, rejectFn) => {
    settle = resolve;
    reject = rejectFn;
  });
  return {
    reader: {
      read: () => {
        const next = queue.shift();
        return next === undefined
          ? pending
          : Promise.resolve({ value: next, done: false as const });
      },
    },
    /** The reader ends normally — the board went away. */
    end: () => settle({ done: true }),
    /** `read()` rejects — the port was closed underneath us. */
    fail: () => reject(new Error("The device has been lost")),
  };
}

const healthySession = {
  feed: () => JSON.stringify({ pinChanges: [] }),
} as unknown as Pick<FirmataSession, "feed">;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pumpReader (ADR-0017)", () => {
  test("a runtime that throws on inbound bytes does not tear down the connection", async () => {
    const closed: string[] = [];
    const seen: number[] = [];
    const { reader, end } = fakeReader([new Uint8Array([1]), new Uint8Array([2])]);

    const pump = pumpReader(reader, healthySession, {
      onBytes: (bytes) => {
        seen.push(bytes[0]);
        // What a poisoned wasm module does to every caller.
        throw new WebAssembly.RuntimeError("unreachable executed");
      },
      onClosed: () => closed.push("closed"),
    });

    await tick();

    // Both chunks were read despite each throwing: the loop is still alive and
    // the board has NOT been reported as lost, so no reconnect is scheduled.
    expect(seen).toEqual([1, 2]);
    expect(closed).toEqual([]);

    // Genuine port loss still closes, exactly once — auto-reconnect is intact.
    end();
    await pump;
    expect(closed).toEqual(["closed"]);
  });

  test("a failing read() is still reported as the port going away", async () => {
    const closed: string[] = [];
    const { reader, fail } = fakeReader([]);
    const pump = pumpReader(reader, healthySession, { onClosed: () => closed.push("closed") });

    fail();
    await pump;

    expect(closed).toEqual(["closed"]);
  });

  test("a throwing detection codec does not end the loop either", async () => {
    const closed: string[] = [];
    const bytes: number[] = [];
    const brokenSession = {
      feed: () => {
        throw new Error("codec panic");
      },
    } as unknown as Pick<FirmataSession, "feed">;
    const { reader, end } = fakeReader([new Uint8Array([9])]);

    const pump = pumpReader(reader, brokenSession, {
      onBytes: (chunk) => bytes.push(chunk[0]),
      onClosed: () => closed.push("closed"),
    });

    await tick();
    // The flow runtime still got its chunk, and the board is still connected.
    expect(bytes).toEqual([9]);
    expect(closed).toEqual([]);

    end();
    await pump;
  });
});
