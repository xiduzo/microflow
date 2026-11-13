import { describe, expect, test } from "bun:test";
import type { Connection } from "@xyflow/react";
import { isValidHandleConnection } from "./connection-validity";

const conn = (source: string, target: string): Connection => ({
  source,
  target,
  sourceHandle: "out",
  targetHandle: "in",
});

describe("isValidHandleConnection", () => {
  test("refuses a self-loop", () => {
    expect(isValidHandleConnection(conn("a", "a"), [])).toBe(false);
  });

  test("accepts an ordinary connection when the handle has no rule", () => {
    expect(isValidHandleConnection(conn("a", "b"), [])).toBe(true);
  });

  test("honours a handle rule that refuses the connection", () => {
    // The answer used to be computed and discarded.
    expect(isValidHandleConnection(conn("a", "b"), [], () => false)).toBe(false);
  });

  test("passes the current edges and the candidate to the handle rule", () => {
    const edges = [{ id: "e1", source: "x", target: "b", targetHandle: "in" }];
    const candidate = conn("a", "b");
    let seen: unknown[] = [];
    isValidHandleConnection(candidate, edges, (e, c) => {
      seen = [e, c];
      return true;
    });
    expect(seen).toEqual([edges, candidate]);
  });
});
