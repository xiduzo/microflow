import { describe, expect, test } from "bun:test";

import { buildEdgeIndex, edgeIdsFor, edgeIndexOf } from "../edge-index";

const edges = [
  { id: "e1", source: "a", sourceHandle: "value" },
  { id: "e2", source: "a", sourceHandle: "value" },
  { id: "e3", source: "a", sourceHandle: "event" },
  { id: "e4", source: "b", sourceHandle: "value" },
  { id: null, source: "a", sourceHandle: "value" },
];

describe("edge index", () => {
  test("returns every wire leaving a (source, handle), in flow order", () => {
    const index = buildEdgeIndex(edges);

    expect(edgeIdsFor(index, "a", "value")).toEqual(["e1", "e2"]);
    expect(edgeIdsFor(index, "a", "event")).toEqual(["e3"]);
    expect(edgeIdsFor(index, "b", "value")).toEqual(["e4"]);
  });

  test("an unwired (source, handle) yields no targets", () => {
    const index = buildEdgeIndex(edges);

    expect(edgeIdsFor(index, "b", "event")).toEqual([]);
    expect(edgeIdsFor(index, "missing", "value")).toEqual([]);
  });

  test("source and handle cannot bleed into each other", () => {
    const index = buildEdgeIndex([
      { id: "e1", source: "ab", sourceHandle: "c" },
      { id: "e2", source: "a", sourceHandle: "bc" },
    ]);

    expect(edgeIdsFor(index, "ab", "c")).toEqual(["e1"]);
    expect(edgeIdsFor(index, "a", "bc")).toEqual(["e2"]);
  });

  test("the index is reused per edge array and rebuilt when the flow changes", () => {
    const first = edgeIndexOf(edges);

    expect(edgeIndexOf(edges)).toBe(first);
    expect(edgeIndexOf([...edges, { id: "e5", source: "b", sourceHandle: "event" }])).not.toBe(
      first,
    );
  });
});
