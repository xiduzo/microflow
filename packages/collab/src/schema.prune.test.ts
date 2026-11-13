import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { FlowDocument, type FlowNode } from "./schema";

const mkNode = (id: string): FlowNode => ({ id, type: "Led", position: { x: 0, y: 0 }, data: {} });

/** Two replicas of one flow, synced, with updates held until `exchange()`. */
function pair() {
  const a = new FlowDocument();
  const b = new FlowDocument();
  a.doc.transact(() => {
    a.addNode(mkNode("x"));
    a.addNode(mkNode("y"));
  }, "seed");
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  const exchange = () => {
    const toB = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
    const toA = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
    Y.applyUpdate(b.doc, toB, "remote");
    Y.applyUpdate(a.doc, toA, "remote");
  };
  return { a, b, exchange };
}

describe("dangling-edge pruning", () => {
  test("a delete racing a new edge to the same node converges with no dangling edge", () => {
    const { a, b, exchange } = pair();
    a.startEdgePruning();
    b.startEdgePruning();

    // Concurrent: A deletes x, B wires y → x. Each is valid where it was made.
    a.removeNode("x");
    b.addEdge({ id: "late", source: "y", target: "x" });
    exchange();
    exchange(); // carry the prune itself across

    for (const doc of [a, b]) {
      expect(doc.hasNode("x")).toBe(false);
      expect(doc.hasEdge("late")).toBe(false);
    }
  });

  test("without pruning, the same race leaves the edge dangling (why this exists)", () => {
    const { a, b, exchange } = pair();
    a.removeNode("x");
    b.addEdge({ id: "late", source: "y", target: "x" });
    exchange();
    expect(a.hasEdge("late")).toBe(true);
    expect(a.hasNode("x")).toBe(false);
  });

  test("starting prunes what is already dangling — the load case", () => {
    const { a, b, exchange } = pair();
    a.removeNode("x");
    b.addEdge({ id: "late", source: "y", target: "x" });
    exchange();

    a.startEdgePruning();
    expect(a.hasEdge("late")).toBe(false);
  });

  test("an edge to a node the document has never seen is left alone", () => {
    // It may simply be ahead of the update that carries its node.
    const doc = new FlowDocument();
    doc.startEdgePruning();
    doc.addEdge({ id: "early", source: "a", target: "b" });
    expect(doc.hasEdge("early")).toBe(true);
  });

  test("the repair is not an undo step", () => {
    const { a, b, exchange } = pair();
    a.startEdgePruning();
    b.addEdge({ id: "late", source: "y", target: "x" });
    a.removeNode("x");
    exchange();
    expect(a.hasEdge("late")).toBe(false);

    a.undo(); // undoes A's own delete — the node comes back
    expect(a.hasNode("x")).toBe(true);
    // The pruned edge stays pruned; it was never A's edit to undo.
    expect(a.hasEdge("late")).toBe(false);
  });

  test("stop ends the pruning", () => {
    const { a, b, exchange } = pair();
    const stop = a.startEdgePruning();
    stop();
    a.removeNode("x");
    b.addEdge({ id: "late", source: "y", target: "x" });
    exchange();
    expect(a.hasEdge("late")).toBe(true);
  });
});
