import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { FlowDocument, upgradeLegacyNodes, type FlowNode } from "../schema";

/**
 * The property ADR-0017 exists for: two people editing one node concurrently
 * must both keep their edit.
 *
 * Every case here fails against the previous storage shape, where a node was a
 * plain object inside a `Y.Map` — an opaque atom Yjs could only replace whole.
 */

const mkNode = (id: string, overrides: Partial<FlowNode> = {}): FlowNode => ({
  id,
  type: "Led",
  position: { x: 0, y: 0 },
  data: { label: "LED", pin: 13 },
  ...overrides,
});

/** Two documents seeded identically, as two clients that have synced. */
function pair(seed: (doc: FlowDocument) => void) {
  const a = new FlowDocument();
  seed(a);
  const b = new FlowDocument();
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  return { a, b };
}

/** Exchange every pending change in both directions. */
function converge(a: FlowDocument, b: FlowDocument) {
  const fromA = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
  const fromB = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
  Y.applyUpdate(b.doc, fromA);
  Y.applyUpdate(a.doc, fromB);
}

describe("concurrent edits to one node", () => {
  test("two different data fields both survive", () => {
    const { a, b } = pair((doc) => doc.addNode(mkNode("n1")));

    // Neither client has seen the other's change yet.
    a.updateNodeData("n1", { label: "Renamed by A" });
    b.updateNodeData("n1", { pin: 7 });

    converge(a, b);

    for (const doc of [a, b]) {
      expect(doc.getNode("n1")!.data).toEqual({ label: "Renamed by A", pin: 7 });
    }
  });

  test("a drag and a rename do not clobber each other", () => {
    const { a, b } = pair((doc) => doc.addNode(mkNode("n1")));

    a.updateNodePosition("n1", { x: 400, y: 250 });
    b.updateNodeData("n1", { label: "Renamed by B" });

    converge(a, b);

    for (const doc of [a, b]) {
      const node = doc.getNode("n1")!;
      expect(node.position).toEqual({ x: 400, y: 250 });
      expect(node.data.label).toBe("Renamed by B");
    }
  });

  test("edits to different nodes are untouched by each other", () => {
    const { a, b } = pair((doc) => {
      doc.addNode(mkNode("n1"));
      doc.addNode(mkNode("n2"));
    });

    a.updateNodeData("n1", { label: "A's node" });
    b.updateNodeData("n2", { label: "B's node" });

    converge(a, b);

    expect(a.getNode("n1")!.data.label).toBe("A's node");
    expect(a.getNode("n2")!.data.label).toBe("B's node");
    expect(b.getNode("n1")!.data.label).toBe("A's node");
  });

  test("the same field written by both converges to one value on both sides", () => {
    const { a, b } = pair((doc) => doc.addNode(mkNode("n1")));

    // A genuine conflict: last-writer-wins is correct here, but both clients
    // must land on the *same* winner.
    a.updateNodeData("n1", { label: "A" });
    b.updateNodeData("n1", { label: "B" });

    converge(a, b);

    expect(a.getNode("n1")!.data.label).toBe(b.getNode("n1")!.data.label);
    expect(["A", "B"]).toContain(a.getNode("n1")!.data.label);
  });

  test("a whole-node write from the bridge still merges with a concurrent field edit", () => {
    const { a, b } = pair((doc) => doc.addNode(mkNode("n1")));

    // A drags (the bridge writes the whole node it holds), B edits a field.
    const held = a.getNode("n1")!;
    a.setNode({ ...held, position: { x: 99, y: 99 } });
    b.updateNodeData("n1", { pin: 3 });

    converge(a, b);

    for (const doc of [a, b]) {
      const node = doc.getNode("n1")!;
      expect(node.position).toEqual({ x: 99, y: 99 });
      // `setNode` skips rewriting `data` when handed back the object it
      // materialised, so B's field edit is not overwritten.
      expect(node.data.pin).toBe(3);
    }
  });
});

describe("materialisation cache", () => {
  test("an untouched node keeps its object identity across reads", () => {
    const doc = new FlowDocument();
    doc.addNode(mkNode("n1"));
    doc.addNode(mkNode("n2"));

    const first = doc.getNodes();
    const second = doc.getNodes();
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);

    // This is what ReactFlow memoises on; losing it re-renders every node on
    // the canvas whenever anybody touches anything.
    doc.updateNodePosition("n1", { x: 5, y: 5 });
    const third = doc.getNodes();
    expect(third[0]).not.toBe(first[0]);
    expect(third[1]).toBe(first[1]);
  });

  test("a data field edit invalidates only that node", () => {
    const doc = new FlowDocument();
    doc.addNode(mkNode("n1"));
    doc.addNode(mkNode("n2"));
    const before = doc.getNodes();

    doc.updateNodeData("n2", { label: "changed" });

    const after = doc.getNodes();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]!.data.label).toBe("changed");
  });

  test("a remote update invalidates the cache", () => {
    const { a, b } = pair((doc) => doc.addNode(mkNode("n1")));
    const before = a.getNode("n1");

    b.updateNodeData("n1", { label: "from B" });
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));

    expect(a.getNode("n1")).not.toBe(before);
    expect(a.getNode("n1")!.data.label).toBe("from B");
  });
});

describe("upgradeLegacyNodes", () => {
  /** A raw document in the pre-ADR-0017 shape: nodes as plain objects. */
  function legacyDoc(): Y.Doc {
    const doc = new Y.Doc();
    doc.transact(() => {
      const nodes = doc.getMap<unknown>("nodes");
      nodes.set("old", mkNode("old", { position: { x: 1, y: 2 } }));
      nodes.set("old2", mkNode("old2", { data: { label: "Second" } }));
    }, "legacy");
    return doc;
  }

  test("converts every flat node and reports how many", () => {
    const raw = legacyDoc();
    expect(upgradeLegacyNodes(raw)).toBe(2);

    const doc = new FlowDocument(raw);
    const node = doc.getNode("old")!;
    expect(node.id).toBe("old");
    expect(node.position).toEqual({ x: 1, y: 2 });
    expect(node.data).toEqual({ label: "LED", pin: 13 });
    expect(doc.getNode("old2")!.data).toEqual({ label: "Second" });
  });

  test("is a no-op on a document that is already current", () => {
    const doc = new FlowDocument();
    doc.addNode(mkNode("n1"));

    expect(upgradeLegacyNodes(doc.doc)).toBe(0);
    expect(doc.getNode("n1")!.data).toEqual({ label: "LED", pin: 13 });
  });

  test("is idempotent", () => {
    const raw = legacyDoc();
    expect(upgradeLegacyNodes(raw)).toBe(2);
    expect(upgradeLegacyNodes(raw)).toBe(0);
    expect(new FlowDocument(raw).getNodes()).toHaveLength(2);
  });

  test("an upgraded node merges like any other", () => {
    const raw = legacyDoc();
    upgradeLegacyNodes(raw);

    // Both clients load the already-migrated document, as they would from the
    // room store, then edit different fields of the same node.
    const a = new FlowDocument(raw);
    const b = new FlowDocument();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));

    a.updateNodeData("old", { label: "A" });
    b.updateNodeData("old", { pin: 4 });
    converge(a, b);

    // Migrating at the load boundary is what removes the one-edit-wide window
    // an on-first-write upgrade would have left.
    expect(a.getNode("old")!.data).toEqual({ label: "A", pin: 4 });
    expect(b.getNode("old")!.data).toEqual({ label: "A", pin: 4 });
  });

  test("the upgrade is not undoable", () => {
    const raw = legacyDoc();
    upgradeLegacyNodes(raw);
    const doc = new FlowDocument(raw);

    doc.updateNodeData("old", { label: "edited" });
    doc.undo();

    // Origin "migration" is outside the UndoManager's tracked set, so undo
    // cannot walk back past it into the flat shape.
    expect(doc.getNode("old")!.data.label).toBe("LED");
    doc.undo();
    expect(doc.getNode("old")).toBeDefined();
  });
});

describe("undo across the nested shape", () => {
  test("a data field edit is undoable", () => {
    const doc = new FlowDocument();
    doc.addNode(mkNode("n1"));
    doc.clearHistory();

    doc.updateNodeData("n1", { label: "changed" });
    expect(doc.getNode("n1")!.data.label).toBe("changed");

    doc.undo();
    expect(doc.getNode("n1")!.data.label).toBe("LED");

    doc.redo();
    expect(doc.getNode("n1")!.data.label).toBe("changed");
  });

  test("a position change is undoable without disturbing data", () => {
    const doc = new FlowDocument();
    doc.addNode(mkNode("n1"));
    doc.clearHistory();

    doc.updateNodeData("n1", { label: "kept" });
    // Past the 500ms capture window these would group; force separate stops.
    doc.undoManager.stopCapturing();
    doc.updateNodePosition("n1", { x: 10, y: 20 });

    doc.undo();
    const node = doc.getNode("n1")!;
    expect(node.position).toEqual({ x: 0, y: 0 });
    expect(node.data.label).toBe("kept");
  });

  test("a remote peer's edit is not swept up by our undo", () => {
    const { a, b } = pair((doc) => doc.addNode(mkNode("n1")));
    a.clearHistory();

    a.updateNodeData("n1", { label: "mine" });
    b.updateNodeData("n1", { pin: 2 });
    converge(a, b);

    a.undo();

    // Undo is scoped to origin "local", so B's field is untouched.
    expect(a.getNode("n1")!.data.pin).toBe(2);
    expect(a.getNode("n1")!.data.label).toBe("LED");
  });
});
