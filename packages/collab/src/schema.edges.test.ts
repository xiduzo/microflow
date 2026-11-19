import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { FlowDocument, decodeEdge, type FlowEdge } from "./schema";

// A stored edge is whatever a client wrote into the shared document, and an
// old import wrote what a file held. The document hands the app only edges it
// can use, and leaves the rest where they are.

const wired: FlowEdge = { id: "wired", source: "a", sourceHandle: "out", target: "b", targetHandle: "in", type: "animated" };

/**
 * The malformed edges the Flow File codec's import tests use: four that are
 * no edge at all, and seven handles that are not a name.
 */
const NOT_AN_EDGE: unknown[] = [
  7,
  { ...wired, id: undefined },
  { ...wired, source: undefined },
  { ...wired, target: 3 },
];
const NOT_A_HANDLE: unknown[] = [null, undefined, "", 3, true, { x: 1 }, ["event"]];
const MALFORMED: Array<[string, unknown]> = [
  ...NOT_AN_EDGE.map((raw, index): [string, unknown] => [`not an edge ${index + 1}`, raw]),
  ...NOT_A_HANDLE.map((handle): [string, unknown] => [`sourceHandle ${JSON.stringify(handle)}`, { ...wired, sourceHandle: handle }]),
  ...NOT_A_HANDLE.map((handle): [string, unknown] => [`targetHandle ${JSON.stringify(handle)}`, { ...wired, targetHandle: handle }]),
];

/** A document holding `wired` and, under the key `bad`, `raw` exactly as given. */
function storing(raw: unknown): FlowDocument {
  const doc = FlowDocument.createEmpty();
  doc.doc.transact(() => {
    doc.edges.set(wired.id, { ...wired });
    (doc.edges as Y.Map<unknown>).set("bad", raw);
  }, "seed");
  return doc;
}

describe("a stored edge the app cannot use", () => {
  test.each(MALFORMED)("is not handed out: %s", (_, raw) => {
    const doc = storing(raw);
    expect(doc.getEdges()).toEqual([wired]);
    expect(doc.getFlowData().edges).toEqual([wired]);
    expect(doc.getEdge("bad")).toBeUndefined();
    doc.destroy();
  });

  test.each(MALFORMED)("stays in the document, and in a copy of it: %s", (_, raw) => {
    const doc = storing(raw);
    doc.startEdgePruning();
    doc.updateNodeData("a", { label: "an edit" });
    expect(doc.hasEdge("bad")).toBe(true);

    const copy = FlowDocument.decode(doc.encode());
    expect(copy.hasEdge("bad")).toBe(true);
    expect(copy.getEdges()).toEqual([wired]);
    copy.destroy();
    doc.destroy();
  });
});

describe("a stored edge the app can use", () => {
  test("is handed out as stored, the same object on every read", () => {
    const doc = storing(7);
    const first = doc.getEdges()[0];
    expect(first).toEqual(wired);
    expect(doc.getEdges()[0]).toBe(first);
    expect(doc.getEdge("wired")).toBe(first);
    doc.destroy();
  });

  test("is handed out in the app's shape when it holds more, still one object across reads", () => {
    const doc = FlowDocument.createEmpty();
    doc.doc.transact(() => {
      (doc.edges as Y.Map<unknown>).set("extra", { ...wired, id: "extra", selected: true, type: "custom", style: { x: 1 } });
    }, "seed");

    const [edge] = doc.getEdges();
    expect(edge).toEqual({ ...wired, id: "extra", type: undefined });
    expect(Object.keys(edge ?? {}).sort()).toEqual(["id", "source", "sourceHandle", "target", "targetHandle"]);
    expect(doc.getEdges()[0]).toBe(edge);
    doc.destroy();
  });

  test("a new value under the same id is read again", () => {
    const doc = storing(7);
    doc.updateEdge("wired", { targetHandle: "other" });
    expect(doc.getEdge("wired")?.targetHandle).toBe("other");
    doc.setEdge({ ...wired, sourceHandle: 5 as unknown as string });
    expect(doc.getEdges()).toEqual([]);
    doc.destroy();
  });
});

describe("decodeEdge", () => {
  test("names what makes a value no edge", () => {
    expect(NOT_AN_EDGE.map(decodeEdge)).toEqual(["not-an-edge", "no-id", "no-source", "no-target"]);
    expect(decodeEdge([wired])).toBe("not-an-edge");
    expect(decodeEdge({ ...wired, id: "" })).toBe("no-id");
  });

  test("a handle that is not a name is no handle", () => {
    for (const handle of NOT_A_HANDLE) {
      expect(decodeEdge({ ...wired, sourceHandle: handle, targetHandle: handle })).toEqual({
        id: "wired",
        source: "a",
        target: "b",
        type: "animated",
      });
    }
  });
});
