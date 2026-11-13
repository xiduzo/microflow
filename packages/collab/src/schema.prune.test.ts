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

/**
 * `nodeWasDeleted` reads Yjs's internal `Y.Map._map` (key → last `Item`) to
 * tell a tombstone from an id the document never held. Yjs has no public API
 * for that. These tests pin the shape the code depends on, so a Yjs upgrade
 * that changes it fails here, by name, instead of silently disabling pruning
 * (a missing `_map` or `deleted` reads as "never held": no edge is ever
 * dangling). `yjs` is pinned to an exact version for the same reason.
 */
describe("Yjs internal: Y.Map._map tombstones (used by nodeWasDeleted)", () => {
  const SHAPE_CHANGED =
    "Yjs changed the shape of Y.Map._map; FlowDocument.nodeWasDeleted reads it — update it before bumping yjs";

  test("_map is a Map from key to an Item carrying a boolean `deleted`", () => {
    const doc = new FlowDocument();
    doc.addNode(mkNode("live"));
    const internal = (doc.nodes as unknown as { _map?: unknown })._map;
    if (!(internal instanceof Map)) throw new Error(`${SHAPE_CHANGED}: _map is not a Map`);
    const item: unknown = internal.get("live");
    if (typeof item !== "object" || item === null || !("deleted" in item)) {
      throw new Error(`${SHAPE_CHANGED}: entry has no \`deleted\``);
    }
    expect(typeof (item as { deleted: unknown }).deleted, SHAPE_CHANGED).toBe("boolean");
    expect((item as { deleted: boolean }).deleted, SHAPE_CHANGED).toBe(false);
  });

  test("a deleted key keeps a tombstone Item with deleted === true", () => {
    const doc = new FlowDocument();
    doc.addNode(mkNode("gone"));
    doc.removeNode("gone");
    const item = doc.nodes._map.get("gone");
    expect(item, SHAPE_CHANGED).toBeDefined();
    expect(item?.deleted, SHAPE_CHANGED).toBe(true);
  });

  test("tombstones replicate: a peer that held the node sees it deleted", () => {
    const { a, b, exchange } = pair();
    a.removeNode("x");
    exchange();
    expect(b.nodeWasDeleted("x"), SHAPE_CHANGED).toBe(true);
    expect(b.nodeWasDeleted("never-held"), SHAPE_CHANGED).toBe(false);
    expect(b.nodeWasDeleted("y"), SHAPE_CHANGED).toBe(false);
  });
});
