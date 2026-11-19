import { describe, expect, test } from "bun:test";
import type { Connection } from "@xyflow/react";
import type { HandleNode } from "../handles";
import { isValidHandleConnection } from "./connection-validity";

const nodes: Record<string, HandleNode> = {
  counter: { type: "Counter", data: {} },
  monitor: { type: "Monitor", data: {} },
  servo: { type: "Servo", data: { type: "continuous" } },
};
const nodeOf = (id: string) => nodes[id];

const conn = (
  source: string,
  target: string,
  sourceHandle = "value",
  targetHandle = "value",
): Connection => ({ source, target, sourceHandle, targetHandle });

describe("isValidHandleConnection", () => {
  test("refuses a self-loop", () => {
    expect(isValidHandleConnection(conn("counter", "counter", "value", "set"), [], nodeOf)).toBe(false);
  });

  test("accepts a connection between handles both nodes offer", () => {
    expect(isValidHandleConnection(conn("counter", "monitor"), [], nodeOf)).toBe(true);
  });

  test("refuses a handle the node does not offer with its current settings", () => {
    // A continuous servo has no `min`; a standard one does.
    expect(isValidHandleConnection(conn("counter", "servo", "value", "min"), [], nodeOf)).toBe(false);
    expect(isValidHandleConnection(conn("counter", "servo", "value", "stop"), [], nodeOf)).toBe(true);
  });

  test("refuses a connection to a node that is not on the canvas", () => {
    expect(isValidHandleConnection(conn("counter", "gone"), [], nodeOf)).toBe(false);
  });

  test("honours a handle rule that refuses the connection", () => {
    expect(isValidHandleConnection(conn("counter", "monitor"), [], nodeOf, () => false)).toBe(false);
  });

  test("passes the current edges and the candidate to the handle rule", () => {
    const edges = [{ id: "e1", source: "x", target: "monitor", targetHandle: "value" }];
    const candidate = conn("counter", "monitor");
    let seen: unknown[] = [];
    isValidHandleConnection(candidate, edges, nodeOf, (e, c) => {
      seen = [e, c];
      return true;
    });
    expect(seen).toEqual([edges, candidate]);
  });
});
