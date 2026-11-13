import { beforeEach, describe, expect, test } from "bun:test";
import { useNodeDiagnosticsStore } from "./node-diagnostics";

const store = () => useNodeDiagnosticsStore.getState();
const shown = (node: string) => store().diagnostics[node];

describe("node diagnostics store", () => {
  beforeEach(() => store().clear());

  test("a runtime clear never wipes what the node reported about itself", () => {
    // The review scenario: an I2C NACK (node), then a rejected input (runtime)
    // on the same node, then the bad edge is deleted (runtime clear).
    store().apply({ node: "tcs", level: "error", message: "no ACK", origin: "node" });
    store().apply({ node: "tcs", level: "warning", message: "bad input", origin: "runtime" });
    expect(shown("tcs")).toEqual({ level: "error", message: "no ACK" });

    store().apply({ node: "tcs", level: "error", message: null, origin: "runtime" });
    expect(shown("tcs")).toEqual({ level: "error", message: "no ACK" });
  });

  test("the most severe origin is shown; a tie goes to the runtime", () => {
    store().apply({ node: "n", level: "warning", message: "own", origin: "node" });
    store().apply({ node: "n", level: "error", message: "not running", origin: "runtime" });
    expect(shown("n")?.message).toBe("not running");

    store().apply({ node: "n", level: "warning", message: "paused", origin: "runtime" });
    expect(shown("n")?.message).toBe("paused");
  });

  test("clearing the last origin clears the node", () => {
    store().apply({ node: "n", level: "warning", message: "own", origin: "node" });
    store().apply({ node: "n", level: "warning", message: null, origin: "node" });
    expect(shown("n")).toBeUndefined();
    expect(store().byOrigin.n).toBeUndefined();
  });
});
