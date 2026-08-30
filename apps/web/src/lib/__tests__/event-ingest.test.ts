import { beforeEach, describe, expect, test } from "bun:test";
import { applyComponentEvent } from "../event-ingest";
import { useNodeDataStore } from "@/stores/node-data";
import { useSignalStore } from "@/stores/signal";
import { useDevLogStore } from "@/stores/dev-log";

// The ingest stores coalesce their writes onto an animation frame, so a burst of
// component events costs one store publish (and one React render) per frame
// instead of one per event. Bun has no DOM, so drive the frame by hand.
let frameCallbacks: FrameRequestCallback[] = [];

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

  useNodeDataStore.setState({ data: {} });
  useSignalStore.setState({ signals: new Map() });
  useDevLogStore.setState({ entries: [], paused: false });
});

/** Run every frame callback queued so far (one frame). */
function tick(): void {
  const callbacks = frameCallbacks;
  frameCallbacks = [];
  for (const callback of callbacks) callback(0);
}

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

    expect(useNodeDataStore.getState().data.sensor).toEqual({ type: "number", value: 2 });
  });

  test("a burst within one frame collapses to a single store publish", () => {
    let publishes = 0;
    const unsubscribe = useNodeDataStore.subscribe(() => publishes++);

    for (let i = 0; i < 50; i += 1) applyComponentEvent(event(i), edges);
    tick();
    unsubscribe();

    expect(publishes).toBe(1);
  });

  test("signals only the edges leaving this (source, handle)", () => {
    applyComponentEvent(event(1), edges);
    tick();

    const signals = useSignalStore.getState().signals;
    expect([...signals.keys()].sort()).toEqual(["e1", "e2"]);
  });

  test("an edge with no signals shares one empty-array identity", () => {
    const a = useSignalStore.getState().getEdgeSignals("e1");
    const b = useSignalStore.getState().getEdgeSignals("e2");
    expect(a).toBe(b);
    expect(a).toEqual([]);
  });

  test("records the event into the dev log", () => {
    applyComponentEvent(event(7), edges);
    tick();

    const entries = useDevLogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.source).toBe("flow");
    expect(entries[0]!.message).toContain("sensor");
  });

  test("a paused dev log records nothing", () => {
    useDevLogStore.setState({ paused: true });
    applyComponentEvent(event(1), edges);
    tick();

    expect(useDevLogStore.getState().entries).toHaveLength(0);
  });

  test("re-indexes when the edge set is replaced", () => {
    applyComponentEvent(event(1), edges);
    tick();
    useSignalStore.setState({ signals: new Map() });

    applyComponentEvent(event(2), [{ id: "e9", source: "sensor", sourceHandle: "value" }]);
    tick();

    expect([...useSignalStore.getState().signals.keys()]).toEqual(["e9"]);
  });
});
