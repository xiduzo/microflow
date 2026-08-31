import { beforeEach, describe, expect, test } from "bun:test";
import { FlowDocument, type FlowEdge, type FlowNode } from "@microflow/collab";
import type { EdgeChange, NodeChange } from "@xyflow/react";
import { ReactFlowBridge } from "./react-flow-bridge";

/**
 * Snapshot identity and write scope — the properties that decide how much
 * work one peer's edit costs everybody else's canvas.
 */

beforeEach(() => {
  (globalThis as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame =
    ((cb: FrameRequestCallback) => {
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

const mkEdge = (id: string, overrides: Partial<FlowEdge> = {}): FlowEdge => ({
  id,
  source: "a",
  target: "b",
  ...overrides,
});

/** A doc with `count` nodes already in it. */
function seededDoc(count: number): FlowDocument {
  const doc = FlowDocument.createEmpty();
  doc.doc.transact(() => {
    for (let i = 0; i < count; i++) {
      doc.addNode(mkNode(`n${i}`, { position: { x: i, y: i } }));
    }
  }, "seed");
  return doc;
}

describe("ReactFlowBridge snapshot identity", () => {
  test("a remote change to one node leaves every other node's identity intact", () => {
    const doc = seededDoc(50);
    const bridge = new ReactFlowBridge(doc);
    const before = bridge.getSnapshot().nodes;

    // A peer moves a single node.
    doc.updateNodePosition("n7", { x: 999, y: 999 });

    const after = bridge.getSnapshot().nodes;
    expect(after).not.toBe(before);

    const changed = after.filter((node, i) => node !== before[i]);
    // Exactly one new object. Rebuilding all 50 is what re-rendered the whole
    // canvas whenever anyone touched anything.
    expect(changed.length).toBe(1);
    expect(changed[0]!.id).toBe("n7");
    expect(changed[0]!.position).toEqual({ x: 999, y: 999 });

    bridge.destroy();
  });

  test("a doc update that changes nothing we render does not notify React", () => {
    const doc = seededDoc(20);
    const bridge = new ReactFlowBridge(doc);

    let notifications = 0;
    bridge.subscribe(() => notifications++);
    const before = bridge.getSnapshot();

    // Touch the document without changing any node: writing an identical
    // value still fires the Y.Map observer.
    doc.doc.transact(() => {
      doc.setNode(doc.getNode("n3")!);
    }, "remote");

    expect(notifications).toBe(0);
    expect(bridge.getSnapshot()).toBe(before);

    bridge.destroy();
  });

  test("local selection survives a remote edit to a different node", () => {
    const doc = seededDoc(5);
    const bridge = new ReactFlowBridge(doc);

    bridge.applyNodeChanges([{ id: "n1", type: "select", selected: true } as NodeChange]);
    expect(bridge.getSnapshot().nodes.find((n) => n.id === "n1")?.selected).toBe(true);

    doc.updateNodePosition("n4", { x: 50, y: 50 });

    expect(bridge.getSnapshot().nodes.find((n) => n.id === "n1")?.selected).toBe(true);
    bridge.destroy();
  });

  test("edges keep identity through an unrelated edge change", () => {
    const doc = FlowDocument.createEmpty();
    doc.doc.transact(() => {
      for (let i = 0; i < 10; i++) doc.addEdge(mkEdge(`e${i}`));
    }, "seed");
    const bridge = new ReactFlowBridge(doc);
    const before = bridge.getSnapshot().edges;

    doc.updateEdge("e2", { target: "z" });

    const after = bridge.getSnapshot().edges;
    expect(after.filter((edge, i) => edge !== before[i]).length).toBe(1);
    bridge.destroy();
  });
});

describe("ReactFlowBridge write scope", () => {
  test("moving one node writes only that node's position key", () => {
    const doc = seededDoc(30);
    const bridge = new ReactFlowBridge(doc);

    // `path` is the route from the nodes map down to whatever changed:
    // `[nodeId]` for the node's own map, `[nodeId, "data"]` for a field.
    const written: string[] = [];
    doc.nodes.observeDeep((events) => {
      for (const event of events) {
        for (const [key, change] of event.changes.keys) {
          if (change.action === "update" || change.action === "add") {
            written.push([...event.path, key].join("."));
          }
        }
      }
    });

    bridge.applyNodeChanges([
      { id: "n5", type: "position", position: { x: 100, y: 100 }, dragging: false } as NodeChange,
    ]);
    bridge.flush();

    // One key, on one node. Under the previous flat shape this was a
    // whole-node replace, which is what made a drag clobber a concurrent
    // rename of the same node.
    expect(written).toEqual(["n5.position"]);
    bridge.destroy();
  });

  test("a data change routed through applyNodeChanges reaches the document", () => {
    const doc = seededDoc(3);
    const bridge = new ReactFlowBridge(doc);

    // Same position and size as the stored node, so `data` is the only
    // difference — otherwise the old position-only diff would write it anyway
    // and the test would prove nothing.
    const stored = doc.getNode("n1")!;
    const replacement = mkNode("n1", { position: { ...stored.position }, data: { pin: 13 } });
    bridge.applyNodeChanges([{ id: "n1", type: "replace", item: replacement } as NodeChange]);
    bridge.flush();

    // The previous diff compared only position and dimensions, so a
    // structural change carrying only new `data` was classified for writing
    // and then discarded.
    expect(doc.getNode("n1")?.data).toEqual({ pin: 13 });
    bridge.destroy();
  });

  test("an edge reconnect updates the stored edge instead of being skipped", () => {
    const doc = FlowDocument.createEmpty();
    doc.doc.transact(() => {
      doc.addEdge(mkEdge("e1", { source: "a", target: "b" }));
    }, "seed");
    const bridge = new ReactFlowBridge(doc);

    const reconnected = mkEdge("e1", { source: "a", target: "c" });
    bridge.applyEdgeChanges([{ id: "e1", type: "replace", item: reconnected } as EdgeChange]);
    bridge.flush();

    expect(doc.getEdge("e1")?.target).toBe("c");
    bridge.destroy();
  });

  test("removing a node deletes it from the document", () => {
    const doc = seededDoc(4);
    const bridge = new ReactFlowBridge(doc);

    bridge.applyNodeChanges([{ id: "n2", type: "remove" } as NodeChange]);
    bridge.flush();

    expect(doc.hasNode("n2")).toBe(false);
    expect(doc.getNodeIds()).toHaveLength(3);
    bridge.destroy();
  });

  test("destroy flushes a pending write instead of dropping it", () => {
    const doc = seededDoc(3);
    const bridge = new ReactFlowBridge(doc);

    // No flush() and no frame boundary — exactly the unmount-right-after-edit
    // case, which previously lost the change.
    bridge.applyNodeChanges([
      { id: "n0", type: "position", position: { x: 42, y: 42 }, dragging: false } as NodeChange,
    ]);
    bridge.destroy();

    expect(doc.getNode("n0")?.position).toEqual({ x: 42, y: 42 });
  });

  test("a read-only bridge still writes nothing", () => {
    const doc = seededDoc(3);
    const bridge = new ReactFlowBridge(doc, { readOnly: true });

    bridge.applyNodeChanges([
      { id: "n0", type: "position", position: { x: 42, y: 42 }, dragging: false } as NodeChange,
    ]);
    bridge.destroy();

    expect(doc.getNode("n0")?.position).toEqual({ x: 0, y: 0 });
  });
});
