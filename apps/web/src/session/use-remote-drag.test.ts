import { describe, expect, test } from "bun:test";
import type { FlowNode } from "@microflow/collab";
import { applyRemoteDrag } from "./use-remote-drag";

const mkNode = (id: string, x: number, y: number, overrides: Partial<FlowNode> = {}): FlowNode => ({
  id,
  type: "Led",
  position: { x, y },
  data: {},
  ...overrides,
});

describe("applyRemoteDrag", () => {
  test("returns the same array when nobody is dragging", () => {
    const nodes = [mkNode("a", 0, 0), mkNode("b", 10, 10)];
    expect(applyRemoteDrag(nodes, null)).toBe(nodes);
  });

  test("moves only the dragged node, preserving every other identity", () => {
    const nodes = [mkNode("a", 0, 0), mkNode("b", 10, 10), mkNode("c", 20, 20)];
    const next = applyRemoteDrag(nodes, { b: { x: 99, y: 98 } });

    expect(next[0]).toBe(nodes[0]);
    expect(next[2]).toBe(nodes[2]);
    expect(next[1]).not.toBe(nodes[1]);
    expect(next[1]!.position).toEqual({ x: 99, y: 98 });
  });

  test("a drag matching the document position changes nothing", () => {
    const nodes = [mkNode("a", 5, 5)];
    // The tail of a drag, once the document has caught up: no new objects.
    expect(applyRemoteDrag(nodes, { a: { x: 5, y: 5 } })).toBe(nodes);
  });

  test("a node the local user is dragging is not overlaid", () => {
    const nodes = [mkNode("a", 0, 0, { dragging: true })];
    // Our own pointer outranks a peer's stale frame for the node in our hand.
    expect(applyRemoteDrag(nodes, { a: { x: 99, y: 99 } })).toBe(nodes);
  });

  test("a drag naming an unknown node is ignored", () => {
    const nodes = [mkNode("a", 0, 0)];
    expect(applyRemoteDrag(nodes, { gone: { x: 1, y: 1 } })).toBe(nodes);
  });

  test("several peers dragging different nodes all apply", () => {
    const nodes = [mkNode("a", 0, 0), mkNode("b", 0, 0), mkNode("c", 0, 0)];
    const next = applyRemoteDrag(nodes, { a: { x: 1, y: 1 }, c: { x: 3, y: 3 } });

    expect(next[0]!.position).toEqual({ x: 1, y: 1 });
    expect(next[1]).toBe(nodes[1]);
    expect(next[2]!.position).toEqual({ x: 3, y: 3 });
  });
});
