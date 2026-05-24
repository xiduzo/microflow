import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FlowDocument, type FlowNode } from "@microflow/collab";
import type { NodeChange } from "@xyflow/react";
import { ReactFlowBridge } from "../react-flow-bridge";
import { RecordingSyncAdapter } from "../recording-sync-adapter";

// -------------------------------------------------------------------------
// requestAnimationFrame polyfill — bun has no DOM; use synchronous frame
// for tests so we can flush deterministically without awaiting paint.
// We override scheduleFlush by always calling flush() explicitly instead.
// -------------------------------------------------------------------------
beforeEach(() => {
  (globalThis as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame =
    ((cb: FrameRequestCallback) => {
      // Defer until next microtask so the same-frame batching still works,
      // but stays deterministic in tests.
      queueMicrotask(() => cb(0));
      return 0;
    }) as typeof requestAnimationFrame;
  (globalThis as { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame =
    (() => {}) as typeof cancelAnimationFrame;
});

const mkNode = (id: string, overrides: Partial<FlowNode> = {}): FlowNode => ({
  id,
  type: "Led",
  position: { x: 0, y: 0 },
  data: {},
  ...overrides,
});

function setup() {
  const doc = FlowDocument.createEmpty();
  const bridge = new ReactFlowBridge(doc);
  return { doc, bridge };
}

afterEach(() => {
  // No-op; each test creates its own doc + bridge.
});

// =========================================================================
// Yjs → React (incoming side)
// =========================================================================
describe("ReactFlowBridge — Yjs → React", () => {
  test("constructor reads initial doc state into snapshot", () => {
    const doc = FlowDocument.createEmpty();
    doc.addNode(mkNode("n0"));
    const bridge = new ReactFlowBridge(doc);
    expect(bridge.getSnapshot().nodes.map((n) => n.id)).toEqual(["n0"]);
  });

  test("Yjs add propagates to snapshot, listener fires", () => {
    const { doc, bridge } = setup();
    let fired = 0;
    bridge.subscribe(() => fired++);
    doc.addNode(mkNode("n1"));
    expect(bridge.getSnapshot().nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(fired).toBe(1);
  });

  test("Yjs remove propagates to snapshot, listener fires", () => {
    const { doc, bridge } = setup();
    doc.addNode(mkNode("n1"));
    let fired = 0;
    bridge.subscribe(() => fired++);
    doc.removeNode("n1");
    expect(bridge.getSnapshot().nodes).toHaveLength(0);
    expect(fired).toBe(1);
  });

  test("Yjs node-data update propagates to snapshot", () => {
    const { doc, bridge } = setup();
    doc.addNode(mkNode("n1", { data: { v: 1 } }));
    doc.updateNodeData("n1", { v: 2 });
    expect(bridge.getSnapshot().nodes[0]!.data.v).toBe(2);
  });

  test("local selection survives Yjs structural arrival", () => {
    const { doc, bridge } = setup();
    doc.addNode(mkNode("n1"));
    bridge.applyNodeChanges([{ type: "select", id: "n1", selected: true }]);
    doc.updateNodeData("n1", { v: 42 });
    const n1 = bridge.getSnapshot().nodes.find((n) => n.id === "n1")!;
    expect(n1.selected).toBe(true);
    expect(n1.data.v).toBe(42);
  });

  test("local dragging flag survives Yjs structural update", () => {
    const { doc, bridge } = setup();
    doc.addNode(mkNode("n1"));
    bridge.applyNodeChanges([
      { type: "position", id: "n1", position: { x: 5, y: 5 }, dragging: true },
    ]);
    expect(bridge.getSnapshot().nodes[0]!.dragging).toBe(true);
    doc.updateNodeData("n1", { v: 1 });
    expect(bridge.getSnapshot().nodes[0]!.dragging).toBe(true);
  });

  test("snapshot identity stable when nothing changed", () => {
    const { bridge } = setup();
    const a = bridge.getSnapshot();
    const b = bridge.getSnapshot();
    expect(a).toBe(b);
  });
});

// =========================================================================
// React → Yjs (outgoing side)
// =========================================================================
describe("ReactFlowBridge — React → Yjs", () => {
  test("add change writes to doc with 'local' origin (UndoManager tracks)", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([{ type: "add", item: mkNode("n1") }]);
    bridge.flush();
    expect(doc.getNodes().map((n) => n.id)).toEqual(["n1"]);
    expect(doc.canUndo()).toBe(true);
  });

  test("remove change writes to doc", () => {
    const { doc, bridge } = setup();
    doc.addNode(mkNode("n1"));
    bridge.applyNodeChanges([{ type: "remove", id: "n1" }]);
    bridge.flush();
    expect(doc.getNodes()).toHaveLength(0);
  });

  test("position change with dragging:true does NOT write to doc", () => {
    const { doc, bridge } = setup();
    doc.addNode(mkNode("n1"));
    const beforeCanUndo = doc.canUndo();
    bridge.applyNodeChanges([
      { type: "position", id: "n1", position: { x: 100, y: 100 }, dragging: true },
    ]);
    bridge.flush();
    // doc position unchanged
    expect(doc.getNodes()[0]!.position).toEqual({ x: 0, y: 0 });
    // no new undo entry
    expect(doc.canUndo()).toBe(beforeCanUndo);
  });

  test("position change with dragging:false writes to doc", () => {
    const { doc, bridge } = setup();
    doc.addNode(mkNode("n1"));
    bridge.applyNodeChanges([
      { type: "position", id: "n1", position: { x: 100, y: 100 }, dragging: false },
    ]);
    bridge.flush();
    expect(doc.getNodes()[0]!.position).toEqual({ x: 100, y: 100 });
  });

  test("dimensions change writes to doc", () => {
    const { doc, bridge } = setup();
    doc.addNode(mkNode("n1"));
    bridge.applyNodeChanges([
      {
        type: "dimensions",
        id: "n1",
        dimensions: { width: 200, height: 80 },
        setAttributes: true,
      },
    ]);
    bridge.flush();
    expect(doc.getNodes()[0]!.width).toBe(200);
    expect(doc.getNodes()[0]!.height).toBe(80);
  });

  test("select change does NOT write to doc, but updates snapshot", () => {
    const { doc, bridge } = setup();
    doc.addNode(mkNode("n1"));
    const beforeCanUndo = doc.canUndo();
    bridge.applyNodeChanges([{ type: "select", id: "n1", selected: true }]);
    bridge.flush();
    expect(doc.canUndo()).toBe(beforeCanUndo);
    expect(bridge.getSnapshot().nodes[0]!.selected).toBe(true);
  });

  test("selected field stays out of Y.Doc on write", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([
      { type: "add", item: mkNode("n1", { selected: true }) },
    ]);
    bridge.flush();
    expect(doc.getNodes()[0]!.selected).toBeUndefined();
  });

  test("dragging field stays out of Y.Doc on write", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([
      { type: "add", item: mkNode("n1", { dragging: true }) },
    ]);
    bridge.flush();
    expect(doc.getNodes()[0]!.dragging).toBeUndefined();
  });

  test("diff skips Y.Doc write when position unchanged", () => {
    const { doc, bridge } = setup();
    doc.addNode(mkNode("n1", { position: { x: 5, y: 5 } }));
    const writesBefore: Uint8Array[] = [];
    doc.onAnyChange((u, origin) => {
      if (origin === "local") writesBefore.push(u);
    });
    // Position-end change but same position → no write
    bridge.applyNodeChanges([
      { type: "position", id: "n1", position: { x: 5, y: 5 }, dragging: false },
    ]);
    bridge.flush();
    expect(writesBefore).toHaveLength(0);
  });

  test("two structural changes in one frame collapse into one transact", () => {
    const { doc, bridge } = setup();
    let localTransactionCount = 0;
    doc.onAnyChange((_u, origin) => {
      if (origin === "local") localTransactionCount++;
    });
    bridge.applyNodeChanges([{ type: "add", item: mkNode("a") }]);
    bridge.applyNodeChanges([{ type: "add", item: mkNode("b") }]);
    bridge.flush();
    expect(localTransactionCount).toBe(1);
    expect(doc.getNodes().map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  test("edge add propagates to doc", () => {
    const { doc, bridge } = setup();
    bridge.applyEdgeChanges([
      { type: "add", item: { id: "e1", source: "a", target: "b" } },
    ]);
    bridge.flush();
    expect(doc.getEdges().map((e) => e.id)).toEqual(["e1"]);
  });

  test("edge remove propagates to doc", () => {
    const { doc, bridge } = setup();
    doc.addEdge({ id: "e1", source: "a", target: "b" });
    bridge.applyEdgeChanges([{ type: "remove", id: "e1" }]);
    bridge.flush();
    expect(doc.getEdges()).toHaveLength(0);
  });

  test("edge select does not propagate to doc", () => {
    const { doc, bridge } = setup();
    doc.addEdge({ id: "e1", source: "a", target: "b" });
    const beforeCanUndo = doc.canUndo();
    bridge.applyEdgeChanges([{ type: "select", id: "e1", selected: true }]);
    bridge.flush();
    expect(doc.canUndo()).toBe(beforeCanUndo);
  });
});

// =========================================================================
// Lifecycle
// =========================================================================
describe("ReactFlowBridge — lifecycle", () => {
  test("destroy unsubscribes from doc observers (no snapshot updates after)", () => {
    const { doc, bridge } = setup();
    bridge.destroy();
    let fired = 0;
    // Listener attempts after destroy are also no-op via cleared listeners,
    // but verify the doc observer is gone: a doc mutation should not crash
    // and the bridge's snapshot would not pick it up.
    doc.addNode(mkNode("n1"));
    expect(fired).toBe(0);
    // Snapshot frozen at construction time
    expect(bridge.getSnapshot().nodes).toHaveLength(0);
  });

  test("destroy clears listeners", () => {
    const { bridge } = setup();
    let fired = 0;
    bridge.subscribe(() => fired++);
    bridge.destroy();
    // Try to trigger a notify by calling applyNodeChanges (post-destroy no-op)
    bridge.applyNodeChanges([{ type: "add", item: mkNode("n1") }]);
    expect(fired).toBe(0);
  });

  test("post-destroy applyNodeChanges is a no-op (idempotent)", () => {
    const { doc, bridge } = setup();
    bridge.destroy();
    expect(() =>
      bridge.applyNodeChanges([{ type: "add", item: mkNode("n1") }]),
    ).not.toThrow();
    expect(doc.getNodes()).toHaveLength(0);
  });

  test("destroy is idempotent", () => {
    const { bridge } = setup();
    bridge.destroy();
    expect(() => bridge.destroy()).not.toThrow();
  });
});

// =========================================================================
// Convergence (headline) — two bridges + two docs + recording adapters
// =========================================================================
describe("ReactFlowBridge — convergence", () => {
  test("structural changes on bridgeA arrive on bridgeB via replay", () => {
    const docA = FlowDocument.createEmpty();
    const docB = FlowDocument.createEmpty();
    const bridgeA = new ReactFlowBridge(docA);
    const bridgeB = new ReactFlowBridge(docB);
    const recordA = new RecordingSyncAdapter({
      doc: docA,
      user: { id: "a", name: "A" },
    });
    const recordB = new RecordingSyncAdapter({
      doc: docB,
      user: { id: "b", name: "B" },
    });

    // User A adds + positions a node
    bridgeA.applyNodeChanges([{ type: "add", item: mkNode("shared") }]);
    bridgeA.applyNodeChanges([
      {
        type: "position",
        id: "shared",
        position: { x: 50, y: 50 },
        dragging: false,
      },
    ]);
    bridgeA.flush();

    // Replay A's updates onto B
    for (const u of recordA.appliedUpdates) recordB.injectRemoteUpdate(u);

    expect(bridgeB.getSnapshot().nodes).toHaveLength(1);
    expect(bridgeB.getSnapshot().nodes[0]!.position).toEqual({ x: 50, y: 50 });
    // recordB itself did not see local writes
    expect(recordB.appliedUpdates).toHaveLength(0);

    bridgeA.destroy();
    bridgeB.destroy();
    recordA.destroy();
    recordB.destroy();
  });
});

// =========================================================================
// Static classification rules (extra coverage on pure helpers)
// =========================================================================
describe("ReactFlowBridge — classifyNodeChange", () => {
  test("add/remove/dimensions/replace are structural", () => {
    expect(ReactFlowBridge.classifyNodeChange({ type: "add", item: mkNode("x") } as NodeChange)).toBe(
      "structural",
    );
    expect(ReactFlowBridge.classifyNodeChange({ type: "remove", id: "x" })).toBe("structural");
    expect(
      ReactFlowBridge.classifyNodeChange({
        type: "dimensions",
        id: "x",
        dimensions: { width: 1, height: 1 },
      } as NodeChange),
    ).toBe("structural");
  });

  test("position depends on dragging flag", () => {
    expect(
      ReactFlowBridge.classifyNodeChange({
        type: "position",
        id: "x",
        position: { x: 1, y: 1 },
        dragging: true,
      }),
    ).toBe("ephemeral");
    expect(
      ReactFlowBridge.classifyNodeChange({
        type: "position",
        id: "x",
        position: { x: 1, y: 1 },
        dragging: false,
      }),
    ).toBe("structural");
  });

  test("select is ephemeral", () => {
    expect(
      ReactFlowBridge.classifyNodeChange({ type: "select", id: "x", selected: true }),
    ).toBe("ephemeral");
  });
});
