import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FlowDocument, type FlowEdge, type FlowNode } from "@microflow/collab";
import type { EdgeChange, NodeChange } from "@xyflow/react";
import { makeSession, provideHandleSets } from "./flow-session";
import { ReactFlowBridge } from "./react-flow-bridge";
import { RecordingSyncAdapter } from "./recording-sync-adapter";

// These sessions are not about handle pruning. A writable session without
// handle sets reports the missing wiring, so give them one that knows no node.
beforeAll(() => provideHandleSets(() => null));
afterAll(() => provideHandleSets(null));

/**
 * Pending local intent versus an incoming doc change.
 *
 * Structural writes wait one frame. A doc change landing inside that frame —
 * a peer's edit, an undo, anything — used to rebuild the snapshot from the doc
 * alone, which silently dropped what the local user had just done: a drag
 * snapped back, a deleted node came back. The bridge now rebases its pending
 * intent over the incoming doc state instead, and the flush writes that intent.
 */

beforeEach(() => {
  // A frame that never fires on its own: every test decides when to flush, so
  // the "doc change before flush" window is held open deliberately.
  (globalThis as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame =
    (() => 1) as typeof requestAnimationFrame;
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

const mkEdge = (id: string, source: string, target: string): FlowEdge => ({
  id,
  source,
  sourceHandle: "out",
  target,
  targetHandle: "in",
});

/** A doc seeded outside the undo-tracked origin, plus a bridge over it. */
function setup(nodeIds: string[] = ["n1", "n2"], edges: FlowEdge[] = []) {
  const doc = FlowDocument.createEmpty();
  doc.doc.transact(() => {
    for (const id of nodeIds) doc.addNode(mkNode(id));
    for (const edge of edges) doc.addEdge(edge);
  }, "seed");
  const bridge = new ReactFlowBridge(doc);
  return { doc, bridge };
}

/** A change from somewhere other than this bridge — a peer, as far as the
 *  bridge can tell. */
function remote(doc: FlowDocument, fn: () => void) {
  doc.doc.transact(fn, "remote");
}

const dragEnd = (id: string, x: number, y: number): NodeChange => ({
  type: "position",
  id,
  position: { x, y },
  dragging: false,
});

const snapNode = (bridge: ReactFlowBridge, id: string) =>
  bridge.getSnapshot().nodes.find((n) => n.id === id);

describe("pending node intent survives a doc change before the flush", () => {
  test("a drag-end is not snapped back by a peer's edit to another node", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([dragEnd("n1", 100, 50)]);

    remote(doc, () => doc.updateNodeData("n2", { label: "peer" }));

    // On screen: still where the user dropped it.
    expect(snapNode(bridge, "n1")?.position).toEqual({ x: 100, y: 50 });
    bridge.flush();
    // In the doc: the drop landed.
    expect(doc.getNode("n1")?.position).toEqual({ x: 100, y: 50 });
    expect(doc.getNode("n2")?.data).toEqual({ label: "peer" });
  });

  test("a drag-end and a peer's data edit to the same node both survive", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([dragEnd("n1", 7, 9)]);

    remote(doc, () => doc.updateNodeData("n1", { label: "renamed" }));

    // Rebased: the doc's new data under the user's pending position.
    expect(snapNode(bridge, "n1")?.position).toEqual({ x: 7, y: 9 });
    expect(snapNode(bridge, "n1")?.data).toEqual({ label: "renamed" });
    bridge.flush();
    // The flush writes the position only — it must not replay stale data over
    // the peer's rename.
    expect(doc.getNode("n1")).toMatchObject({
      position: { x: 7, y: 9 },
      data: { label: "renamed" },
    });
  });

  test("a resize is not undone by a doc change before the flush", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([
      { type: "dimensions", id: "n1", dimensions: { width: 220, height: 90 }, setAttributes: true },
    ]);
    remote(doc, () => doc.updateNodePosition("n2", { x: 1, y: 1 }));
    bridge.flush();
    expect(doc.getNode("n1")).toMatchObject({ width: 220, height: 90 });
  });

  test("a deleted node is not resurrected by a doc change before the flush", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([{ type: "remove", id: "n1" }]);

    remote(doc, () => doc.updateNodeData("n2", { label: "peer" }));

    expect(snapNode(bridge, "n1")).toBeUndefined();
    bridge.flush();
    expect(doc.hasNode("n1")).toBe(false);
  });

  test("a delete wins over a peer's concurrent edit to the same node", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([{ type: "remove", id: "n1" }]);

    remote(doc, () => doc.updateNodeData("n1", { label: "peer" }));

    expect(snapNode(bridge, "n1")).toBeUndefined();
    bridge.flush();
    expect(doc.hasNode("n1")).toBe(false);
  });

  test("a locally added node survives a doc change before the flush", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([{ type: "add", item: mkNode("fresh", { position: { x: 3, y: 4 } }) }]);

    remote(doc, () => doc.updateNodeData("n2", { label: "peer" }));

    expect(snapNode(bridge, "fresh")?.position).toEqual({ x: 3, y: 4 });
    bridge.flush();
    expect(doc.getNode("fresh")?.position).toEqual({ x: 3, y: 4 });
  });

  test("a peer's delete wins over a pending local move — no resurrection by write", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([dragEnd("n1", 100, 100)]);

    remote(doc, () => doc.removeNode("n1"));

    expect(snapNode(bridge, "n1")).toBeUndefined();
    bridge.flush();
    expect(doc.hasNode("n1")).toBe(false);
  });

  test("a node mid-drag is not snapped back by an unrelated doc change", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([
      { type: "position", id: "n1", position: { x: 40, y: 40 }, dragging: true },
    ]);

    remote(doc, () => doc.updateNodeData("n2", { label: "peer" }));

    expect(snapNode(bridge, "n1")?.position).toEqual({ x: 40, y: 40 });
    expect(snapNode(bridge, "n1")?.dragging).toBe(true);
    // Still ephemeral: nothing reached the doc.
    bridge.flush();
    expect(doc.getNode("n1")?.position).toEqual({ x: 0, y: 0 });
  });

  test("the flush is still one local transaction — one undo step", () => {
    const { doc, bridge } = setup();
    let local = 0;
    doc.onAnyChange((_u, origin) => {
      if (origin === "local") local++;
    });
    bridge.applyNodeChanges([dragEnd("n1", 5, 5), { type: "remove", id: "n2" }]);
    remote(doc, () => doc.updateNodeData("n1", { label: "peer" }));
    bridge.flush();
    expect(local).toBe(1);
    doc.undo();
    expect(doc.getNode("n1")?.position).toEqual({ x: 0, y: 0 });
    expect(doc.hasNode("n2")).toBe(true);
  });

  test("a selection-only replace (select-all) does not write a stale copy over a peer's edit", () => {
    // Mod+A calls ReactFlow's setNodes, which arrives here as `replace`
    // changes carrying the whole node — with the data as it was at that moment.
    const { doc, bridge } = setup();
    const n1 = snapNode(bridge, "n1")!;
    bridge.applyNodeChanges([{ type: "replace", id: "n1", item: { ...n1, selected: true } }]);

    remote(doc, () => doc.updateNodeData("n1", { label: "peer" }));

    expect(snapNode(bridge, "n1")?.data).toEqual({ label: "peer" });
    expect(snapNode(bridge, "n1")?.selected).toBe(true);
    bridge.flush();
    expect(doc.getNode("n1")?.data).toEqual({ label: "peer" });
  });

  test("a data replace writes only the keys it changed", () => {
    const { doc, bridge } = setup();
    remote(doc, () => doc.updateNodeData("n1", { pin: 1, label: "a" }));
    const n1 = snapNode(bridge, "n1")!;
    bridge.applyNodeChanges([
      { type: "replace", id: "n1", item: { ...n1, data: { ...n1.data, pin: 13 } } },
    ]);

    remote(doc, () => doc.updateNodeData("n1", { label: "peer" }));

    expect(snapNode(bridge, "n1")?.data).toEqual({ pin: 13, label: "peer" });
    bridge.flush();
    expect(doc.getNode("n1")?.data).toEqual({ pin: 13, label: "peer" });
  });

  test("a node with pending intent keeps its identity through an unrelated doc change", () => {
    const { doc, bridge } = setup();
    const n1 = snapNode(bridge, "n1")!;
    bridge.applyNodeChanges([
      dragEnd("n1", 3, 3),
      { type: "replace", id: "n1", item: { ...n1, position: { x: 3, y: 3 }, data: { pin: 2 } } },
    ]);
    const before = snapNode(bridge, "n1");

    remote(doc, () => doc.updateNodeData("n2", { label: "peer" }));

    // Rebasing must not hand ReactFlow a fresh object (and a re-render) for
    // a node whose rendered fields did not move.
    expect(snapNode(bridge, "n1")).toBe(before);
  });

  test("intent is spent by the flush — a later doc change wins normally", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([dragEnd("n1", 5, 5)]);
    bridge.flush();
    remote(doc, () => doc.updateNodePosition("n1", { x: 99, y: 99 }));
    expect(snapNode(bridge, "n1")?.position).toEqual({ x: 99, y: 99 });
  });
});

describe("pending edge intent survives a doc change before the flush", () => {
  test("a deleted edge is not resurrected", () => {
    const { doc, bridge } = setup(["n1", "n2"], [mkEdge("e1", "n1", "n2")]);
    bridge.applyEdgeChanges([{ type: "remove", id: "e1" } as EdgeChange]);

    remote(doc, () => doc.addEdge(mkEdge("e2", "n2", "n1")));

    expect(bridge.getSnapshot().edges.map((e) => e.id)).toEqual(["e2"]);
    bridge.flush();
    expect(doc.hasEdge("e1")).toBe(false);
    expect(doc.hasEdge("e2")).toBe(true);
  });

  test("a new edge survives", () => {
    const { doc, bridge } = setup();
    bridge.applyEdgeChanges([{ type: "add", item: mkEdge("e1", "n1", "n2") } as EdgeChange]);

    remote(doc, () => doc.updateNodeData("n2", { label: "peer" }));
    remote(doc, () => doc.addEdge(mkEdge("e2", "n2", "n1")));

    expect(bridge.getSnapshot().edges.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
    bridge.flush();
    expect(doc.hasEdge("e1")).toBe(true);
  });
});

describe("remove and re-add of one id inside a frame", () => {
  test("an unchanged re-add keeps the node", () => {
    const { doc, bridge } = setup();
    const n1 = snapNode(bridge, "n1")!;
    bridge.applyNodeChanges([{ type: "remove", id: "n1" }]);
    bridge.applyNodeChanges([{ type: "add", item: n1 }]);

    expect(snapNode(bridge, "n1")).toBeDefined();
    bridge.flush();
    expect(doc.hasNode("n1")).toBe(true);
  });

  test("a changed re-add writes the change", () => {
    const { doc, bridge } = setup();
    const n1 = snapNode(bridge, "n1")!;
    bridge.applyNodeChanges([{ type: "remove", id: "n1" }]);
    bridge.applyNodeChanges([{ type: "add", item: { ...n1, position: { x: 5, y: 6 } } }]);

    bridge.flush();
    expect(doc.getNode("n1")?.position).toEqual({ x: 5, y: 6 });
  });
});

describe("deleting a node leaves no dangling edge", () => {
  test("a new local edge to a node a peer deleted inside the frame is not written", () => {
    const { doc, bridge } = setup();
    bridge.applyEdgeChanges([{ type: "add", item: mkEdge("e1", "n1", "n2") } as EdgeChange]);

    remote(doc, () => doc.removeNode("n2"));

    expect(bridge.getSnapshot().edges).toHaveLength(0);
    bridge.flush();
    expect(doc.hasEdge("e1")).toBe(false);
  });

  test("the editor session prunes once; the canvas starts no second pruner", () => {
    const doc = FlowDocument.createEmpty();
    doc.doc.transact(() => {
      doc.addNode(mkNode("n1"));
      doc.addNode(mkNode("n2"));
    }, "seed");
    let started = 0;
    const start = doc.startEdgePruning.bind(doc);
    doc.startEdgePruning = () => {
      started += 1;
      return start();
    };
    const session = makeSession("local", "f", doc, { kind: "local", destroy() {} }, false);
    const bridge = new ReactFlowBridge(session.doc);
    // A peer's edge to a node another peer deleted, merged in afterwards.
    remote(doc, () => doc.deleteNode("n2"));
    remote(doc, () => doc.addEdge(mkEdge("late", "n1", "n2")));

    expect(started).toBe(1);
    expect(doc.hasEdge("late")).toBe(false);
    expect(bridge.getSnapshot().edges).toHaveLength(0);
    bridge.destroy();
    session.destroy();
  });

  test("an edge a peer attached before the flush goes with the node", () => {
    const { doc, bridge } = setup();
    bridge.applyNodeChanges([{ type: "remove", id: "n1" }]);

    remote(doc, () => doc.addEdge(mkEdge("late", "n2", "n1")));
    bridge.flush();

    expect(doc.hasNode("n1")).toBe(false);
    expect(doc.hasEdge("late")).toBe(false);
    expect(bridge.getSnapshot().edges).toHaveLength(0);
  });
});

describe("two peers converge with both edits intact", () => {
  test("A's drag and B's rename cross in flight", () => {
    const docA = FlowDocument.createEmpty();
    const docB = FlowDocument.createEmpty();
    const recA = new RecordingSyncAdapter({ doc: docA, user: { id: "a", name: "A" } });
    const recB = new RecordingSyncAdapter({ doc: docB, user: { id: "b", name: "B" } });
    docA.doc.transact(() => docA.addNode(mkNode("shared")), "seed");
    for (const u of recA.appliedUpdates.splice(0)) recB.injectRemoteUpdate(u);
    expect(docB.hasNode("shared")).toBe(true);

    const bridgeA = new ReactFlowBridge(docA);
    // A drops the node; before A's frame flushes, B's rename arrives.
    bridgeA.applyNodeChanges([dragEnd("shared", 64, 32)]);
    docB.updateNodeData("shared", { label: "B was here" });
    for (const u of recB.appliedUpdates.splice(0)) recA.injectRemoteUpdate(u);
    bridgeA.flush();
    for (const u of recA.appliedUpdates.splice(0)) recB.injectRemoteUpdate(u);

    for (const doc of [docA, docB]) {
      expect(doc.getNode("shared")).toMatchObject({
        position: { x: 64, y: 32 },
        data: { label: "B was here" },
      });
    }
    bridgeA.destroy();
    recA.destroy();
    recB.destroy();
  });
});
