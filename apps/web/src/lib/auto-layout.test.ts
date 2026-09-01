import { describe, expect, it } from "bun:test";
import type { FlowEdge, FlowNode } from "@microflow/collab";

import { autoLayout } from "./auto-layout";

const node = (id: string): FlowNode => ({
  id,
  type: "Led",
  position: { x: 0, y: 0 },
  data: {},
});

const edge = (source: string, target: string): FlowEdge => ({
  id: `${source}-${target}`,
  source,
  target,
});

describe("autoLayout", () => {
  it("puts a chain in left-to-right columns", () => {
    const laid = autoLayout([node("a"), node("b"), node("c")], [edge("a", "b"), edge("b", "c")]);
    const x = Object.fromEntries(laid.map((n) => [n.id, n.position.x]));

    expect(x.a).toBeLessThan(x.b);
    expect(x.b).toBeLessThan(x.c);
    // Roomy: a column gap is the node width plus the rank gap.
    expect(x.b - x.a).toBeGreaterThanOrEqual(400);
  });

  it("stacks siblings in one column without overlapping", () => {
    const laid = autoLayout([node("a"), node("b"), node("c")], [edge("a", "b"), edge("a", "c")]);
    const b = laid.find((n) => n.id === "b")!;
    const c = laid.find((n) => n.id === "c")!;

    expect(b.position.x).toBe(c.position.x);
    expect(Math.abs(b.position.y - c.position.y)).toBeGreaterThanOrEqual(220);
  });

  it("places unconnected nodes rather than dropping them", () => {
    expect(autoLayout([node("a"), node("b")], [])).toHaveLength(2);
  });

  it("ignores edges pointing at nodes that are gone", () => {
    const laid = autoLayout([node("a")], [edge("a", "ghost")]);
    expect(laid).toHaveLength(1);
  });

  it("is a no-op on an empty flow", () => {
    expect(autoLayout([], [])).toEqual([]);
  });
});
