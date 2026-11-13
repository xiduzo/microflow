import { describe, expect, test } from "bun:test";
import { FlowDocument, type FlowEdge, type FlowNode } from "@microflow/collab";
import { removeEdgesAtHandles, removeNodesWithEdges } from "./flow-edits";
import { readOnlyDocument } from "./read-only-document";

const mkNode = (id: string): FlowNode => ({ id, type: "Led", position: { x: 0, y: 0 }, data: {} });
const mkEdge = (id: string, source: string, sourceHandle: string, target: string, targetHandle: string): FlowEdge => ({
  id,
  source,
  sourceHandle,
  target,
  targetHandle,
});

function seeded() {
  const doc = FlowDocument.createEmpty();
  doc.doc.transact(() => {
    for (const id of ["a", "b", "c"]) doc.addNode(mkNode(id));
    doc.addEdge(mkEdge("ab", "a", "out", "b", "in"));
    doc.addEdge(mkEdge("bc", "b", "out", "c", "in"));
    doc.addEdge(mkEdge("ca", "c", "other", "a", "in"));
  }, "seed");
  return doc;
}

describe("removeNodesWithEdges", () => {
  test("removes the nodes and every edge touching them, as one undo step", () => {
    const doc = seeded();
    const removed = removeNodesWithEdges(doc, ["a"]);
    expect(removed.sort()).toEqual(["ab", "ca"]);
    expect(doc.getNodeIds().sort()).toEqual(["b", "c"]);
    expect(doc.getEdgeIds()).toEqual(["bc"]);

    doc.undo();
    expect(doc.getNodeIds().sort()).toEqual(["a", "b", "c"]);
    expect(doc.getEdgeIds().sort()).toEqual(["ab", "bc", "ca"]);
  });

  test("leaves no dangling edge for a batch", () => {
    const doc = seeded();
    removeNodesWithEdges(doc, ["a", "b"]);
    for (const edge of doc.getEdges()) {
      expect(doc.hasNode(edge.source) && doc.hasNode(edge.target)).toBe(true);
    }
  });

  test("is a no-op through a Viewer's read-only document", () => {
    const doc = seeded();
    removeNodesWithEdges(readOnlyDocument(doc), ["a"]);
    expect(doc.getNodeIds()).toHaveLength(3);
    expect(doc.getEdgeIds()).toHaveLength(3);
  });
});

describe("dangling-edge pruning through a Viewer's document", () => {
  test("a Viewer never prunes, now or later", () => {
    const doc = seeded();
    // Leave a dangling edge the way a concurrent peer would: node gone, edge kept.
    doc.deleteNode("a");
    expect(doc.hasEdge("ab")).toBe(true);

    const viewer = readOnlyDocument(doc);
    const stop = viewer.startEdgePruning();
    viewer.pruneDanglingEdges();
    doc.deleteNode("b"); // a later transaction that would trigger a prune
    expect(doc.getEdgeIds().sort()).toEqual(["ab", "bc", "ca"]);
    stop?.();
  });
});

describe("removeEdgesAtHandles", () => {
  test("removes only the edges on the named handles of that node", () => {
    const doc = seeded();
    expect(removeEdgesAtHandles(doc, "c", ["other"])).toEqual(["ca"]);
    expect(doc.getEdgeIds().sort()).toEqual(["ab", "bc"]);
  });

  test("is a no-op through a Viewer's read-only document", () => {
    const doc = seeded();
    removeEdgesAtHandles(readOnlyDocument(doc), "c", ["other", "in"]);
    expect(doc.getEdgeIds()).toHaveLength(3);
  });

  test("why it exists: the raw Y.Map under the proxy is still writable", () => {
    // What `useDeleteHandles` used to do. The proxy guards mutator *methods*;
    // `edges` is the bare Y.Map and passes straight through.
    const doc = seeded();
    const viewer = readOnlyDocument(doc);
    viewer.doc.transact(() => viewer.edges.delete("ca"), "local");
    expect(doc.hasEdge("ca")).toBe(false);
  });
});
