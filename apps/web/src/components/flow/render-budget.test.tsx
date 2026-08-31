/**
 * Render-budget tests: the canvas half of the performance work, asserted as
 * **counts** rather than timings.
 *
 * Wall-clock in a browser is the wrong instrument here — noisy,
 * machine-dependent, and useless as a CI regression guard. But every render
 * optimisation has an exact, countable consequence, and unlike a duration it
 * either holds or it doesn't. A regression flips an integer.
 *
 * ## Each event gets its own task, and that is the whole point
 *
 * React already batches every synchronous update inside one task into a single
 * render. So a test that fires a hundred events inside one `act()` shows one
 * render **with or without** the store batching in this branch — it proves
 * nothing. An earlier draft of this file did exactly that and passed against
 * both versions.
 *
 * Component events do not arrive that way. Each one lands in its own task: the
 * desktop delivers one Tauri IPC callback per event, and the browser applies
 * one `Effects` per `feedBytes` return. `deliverInOwnTask` models that, and it
 * is the difference between a test that measures something and a test that
 * measures React's own batching.
 *
 * ## Two kinds of test below
 *
 * - **improvements** — verified to fail against the pre-branch stores.
 * - **invariants** — properties that already held; here so they keep holding.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Must register before React DOM is imported, so it sees a document.
GlobalRegistrator.register();
// React only permits `act` when the environment opts in.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NodeContainerContext } from "./nodes/_base/node-context";
import { nodeDataStore, useNodeValue } from "@/stores/node-data";
import { signalStore, useEdgeSignals } from "@/stores/signal";
import { applyComponentEvent } from "@/lib/event-ingest";
import { useDevLogStore } from "@/stores/dev-log";

// ---------------------------------------------------------------------------
// Deterministic animation frames
// ---------------------------------------------------------------------------

let frameQueue: FrameRequestCallback[] = [];

/** Run every frame callback queued so far — one frame's worth of flushes. */
function frame(): void {
  const callbacks = frameQueue;
  frameQueue = [];
  act(() => {
    for (const callback of callbacks) callback(performance.now());
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  frameQueue = [];
  (globalThis as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame =
    ((callback: FrameRequestCallback) => {
      frameQueue.push(callback);
      return frameQueue.length;
    }) as typeof requestAnimationFrame;
  (globalThis as { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame =
    (() => {}) as typeof cancelAnimationFrame;

  nodeDataStore.clear();
  signalStore.clearSignals();
  useDevLogStore.setState({ entries: [], paused: true });

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** Renders exactly what a value-displaying node body does, and counts itself. */
function ValueProbe({ id, renders }: { id: string; renders: Map<string, number> }) {
  return (
    <NodeContainerContext.Provider value={{ id } as never}>
      <ValueProbeBody id={id} renders={renders} />
    </NodeContainerContext.Provider>
  );
}

function ValueProbeBody({ id, renders }: { id: string; renders: Map<string, number> }) {
  // `useNodeValue` hands back the whole `ComponentValue`, exactly as a node body
  // receives it — the probe renders its payload so a test can read what landed.
  const value = useNodeValue<{ type: string; value: number } | null>(null);
  renders.set(id, (renders.get(id) ?? 0) + 1);
  return <span>{value ? String(value.value) : "none"}</span>;
}

/** Subscribes the way `AnimatedEdge` does, and counts itself. */
function EdgeProbe({ id, renders }: { id: string; renders: Map<string, number> }) {
  const { signals } = useEdgeSignals(id);
  renders.set(id, (renders.get(id) ?? 0) + 1);
  return <span>{signals.length}</span>;
}

const numberEvent = (source: string, value: number) => ({
  source,
  sourceHandle: "value",
  value: { type: "number" as const, value },
});

/**
 * Deliver each event in its own `act()`, i.e. its own task — the way both hosts
 * actually deliver them. Batching them into one `act()` would let React's own
 * per-task batching do the coalescing and hide whether the store batches at all.
 */
function deliverInOwnTask(events: ReturnType<typeof numberEvent>[], edges: EdgeInput[]): void {
  for (const event of events) {
    act(() => {
      applyComponentEvent(event, edges);
    });
  }
}

type EdgeInput = { id: string; source: string; sourceHandle: string };

// ---------------------------------------------------------------------------

describe("node render budget (improvements)", () => {
  test("a burst of events for one node costs that node one render per frame", () => {
    const renders = new Map<string, number>();
    act(() => {
      root.render(<ValueProbe id="sensor" renders={renders} />);
    });
    const afterMount = renders.get("sensor")!;

    // 100 events — a streaming sensor's worth — each in its own task, all
    // within one frame.
    deliverInOwnTask(
      Array.from({ length: 100 }, (_, i) => numberEvent("sensor", i)),
      [],
    );
    frame();

    const renderCount = renders.get("sensor")! - afterMount;
    // Measured against the pre-branch stores: 100 renders, one per event,
    // because each event is its own task and React has nothing to batch it
    // with. A hundredfold difference on the canvas's hottest path.
    expect(renderCount).toBe(1);
  });

});

// These two held before this branch too. They are here as regression guards,
// not as evidence for it — a batching change is exactly the kind of edit that
// could quietly break either one.
describe("node render budget (invariants)", () => {
  test("only the node whose value changed re-renders", () => {
    const renders = new Map<string, number>();
    const ids = Array.from({ length: 50 }, (_, i) => `node${i}`);

    act(() => {
      root.render(
        <>
          {ids.map((id) => (
            <ValueProbe key={id} id={id} renders={renders} />
          ))}
        </>,
      );
    });
    const baseline = new Map(renders);

    deliverInOwnTask([numberEvent("node7", 42)], []);
    frame();

    const moved = ids.filter((id) => renders.get(id)! > baseline.get(id)!);
    // The store keys its listeners by node id, so the other 49 are never even
    // woken. That routing is the property worth guarding: it is what keeps a
    // 200-node canvas cheap under a streaming sensor.
    expect(moved).toEqual(["node7"]);
  });

  test("the value that lands is the last of the burst, not an intermediate", () => {
    const renders = new Map<string, number>();
    act(() => {
      root.render(<ValueProbe id="sensor" renders={renders} />);
    });

    deliverInOwnTask(
      Array.from({ length: 100 }, (_, i) => numberEvent("sensor", i + 1)),
      [],
    );
    frame();

    // Coalescing must not lose the newest value — only the ones no frame would
    // ever have painted.
    expect(container.textContent).toContain("100");
  });
});

describe("edge render budget", () => {
  // The idle-edge case below is an invariant (`useShallow` already compared two
  // empty arrays equal); the burst case underneath it is an improvement.
  const edges = [
    { id: "e1", source: "a", sourceHandle: "value" },
    { id: "e2", source: "b", sourceHandle: "value" },
  ];

  test("an edge with no signal does not re-render when another edge signals", () => {
    const renders = new Map<string, number>();
    act(() => {
      root.render(
        <>
          <EdgeProbe id="e1" renders={renders} />
          <EdgeProbe id="e2" renders={renders} />
        </>,
      );
    });
    const baseline = new Map(renders);

    // Only `a` fires, so only `e1` carries a signal.
    deliverInOwnTask([numberEvent("a", 1)], edges);
    frame();

    expect(renders.get("e1")!).toBeGreaterThan(baseline.get("e1")!);
    // `e2` has no entry in the store, so its listener is never called. Before,
    // every signal anywhere re-rendered every edge.
    expect(renders.get("e2")!).toBe(baseline.get("e2")!);
  });

  test("a burst of signals on one edge costs one render per frame", () => {
    const renders = new Map<string, number>();
    act(() => {
      root.render(<EdgeProbe id="e1" renders={renders} />);
    });
    const baseline = renders.get("e1")!;

    deliverInOwnTask(
      Array.from({ length: 60 }, (_, i) => numberEvent("a", i)),
      edges,
    );
    frame();

    // Measured against the pre-branch stores: 60 renders, one per signal.
    expect(renders.get("e1")! - baseline).toBe(1);
  });
});
