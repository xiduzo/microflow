import { beforeEach, describe, expect, test } from "bun:test";
import { applyComponentEvent } from "./event-ingest";
import { nodeDataStore } from "@/stores/node-data";
import { signalStore } from "@/stores/signal";
import { useDevLogStore } from "@/stores/dev-log";

// The ingest stores coalesce their writes onto an animation frame, so a burst of
// component events costs one store publish (and one React render) per frame
// instead of one per event. Bun has no DOM, so drive the frame by hand.
let frameCallbacks: FrameRequestCallback[] = [];

/** The dev log batches on a timer rather than a frame; long enough to cover it. */
const DEV_LOG_FLUSH_MS = 150;

beforeEach(() => {
  frameCallbacks = [];
  (globalThis as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame = ((
    callback: FrameRequestCallback,
  ) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  }) as typeof requestAnimationFrame;
  (globalThis as { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame =
    (() => {}) as typeof cancelAnimationFrame;

  nodeDataStore.clear();
  signalStore.clearSignals();
  // `clear()` rather than `setState`: the dev log buffers records outside React,
  // and bun shares one process across test files, so an earlier burst still in
  // that buffer would flush into this test's entries.
  useDevLogStore.getState().clear();
  useDevLogStore.setState({ paused: false });
});

/** Run every frame callback queued so far (one frame). */
function tick(): void {
  const callbacks = frameCallbacks;
  frameCallbacks = [];
  for (const callback of callbacks) callback(0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const edges = [
  { id: "e1", source: "sensor", sourceHandle: "value" },
  { id: "e2", source: "sensor", sourceHandle: "value" },
  { id: "e3", source: "sensor", sourceHandle: "other" },
  { id: "e4", source: "elsewhere", sourceHandle: "value" },
];

const event = (value: number) => ({
  source: "sensor",
  sourceHandle: "value",
  value: { type: "number" as const, value },
});

describe("applyComponentEvent", () => {
  test("publishes the node's latest value after a frame", () => {
    applyComponentEvent(event(1), edges);
    applyComponentEvent(event(2), edges);
    tick();

    expect(nodeDataStore.get("sensor")).toEqual({ type: "number", value: 2 });
  });

  test("a burst within one frame collapses to a single store publish", () => {
    let publishes = 0;
    const unsubscribe = nodeDataStore.subscribe("sensor", () => publishes++);

    for (let i = 0; i < 50; i += 1) applyComponentEvent(event(i), edges);
    tick();
    unsubscribe();

    expect(publishes).toBe(1);
  });

  test("signals only the edges leaving this (source, handle)", () => {
    applyComponentEvent(event(1), edges);
    tick();

    expect(signalStore.edgeIds().sort()).toEqual(["e1", "e2"]);
  });

  test("an edge with no signals shares one empty-frame identity", () => {
    const a = signalStore.get("e1");
    const b = signalStore.get("e2");
    expect(a).toBe(b);
    expect(a.signals).toEqual([]);
  });

  test("records the event into the dev log", async () => {
    applyComponentEvent(event(7), edges);
    await sleep(DEV_LOG_FLUSH_MS);

    const entries = useDevLogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.source).toBe("flow");
    expect(entries[0]!.message).toContain("sensor");
  });

  test("a paused dev log records nothing", async () => {
    useDevLogStore.setState({ paused: true });
    applyComponentEvent(event(1), edges);
    await sleep(DEV_LOG_FLUSH_MS);

    expect(useDevLogStore.getState().entries).toHaveLength(0);
  });

  test("re-indexes when the edge set is replaced", () => {
    applyComponentEvent(event(1), edges);
    tick();
    signalStore.clearSignals();

    applyComponentEvent(event(2), [{ id: "e9", source: "sensor", sourceHandle: "value" }]);
    tick();

    expect(signalStore.edgeIds()).toEqual(["e9"]);
  });
});
