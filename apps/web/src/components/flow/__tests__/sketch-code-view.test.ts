import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import {
  buildGenerateSketchCommand,
  projectSketchResult,
  type SketchInvoker,
} from "../sketch-code-view.model";

const NODE: Node = {
  id: "led-1",
  type: "Led",
  position: { x: 0, y: 0 },
  data: { pin: 13 },
};

describe("buildGenerateSketchCommand", () => {
  test("wraps the current Flow graph in a generate_sketch command", () => {
    const nodes: Node[] = [NODE];
    const edges: Edge[] = [{ id: "e1", source: "a", target: "b" }];

    const command = buildGenerateSketchCommand(nodes, edges);

    expect(command).toEqual({
      type: "generate_sketch",
      flow: { nodes, edges },
    });
  });

  test("supports an empty Flow", () => {
    expect(buildGenerateSketchCommand([], [])).toEqual({
      type: "generate_sketch",
      flow: { nodes: [], edges: [] },
    });
  });
});

describe("projectSketchResult", () => {
  // Scenario: Opening the Code view shows the sketch read-only
  test("on success the editor value is the generated sketch text", async () => {
    const invoker: SketchInvoker = async () => ({
      success: true,
      data: "void setup() {}\nvoid loop() {}",
    });

    const state = await projectSketchResult(invoker, [NODE], []);

    expect(state).toEqual({
      value: "void setup() {}\nvoid loop() {}",
      isError: false,
    });
  });

  // Scenario: The shown sketch can be copied — the full text is preserved verbatim
  test("the full sketch text is preserved verbatim for copying", async () => {
    const sketch = [
      "// microflow generated sketch",
      "void setup() {",
      "  pinMode(13, OUTPUT);",
      "}",
      "void loop() {}",
    ].join("\n");
    const invoker: SketchInvoker = async () => ({ success: true, data: sketch });

    const state = await projectSketchResult(invoker, [NODE], []);

    expect(state.value).toBe(sketch);
  });

  // Scenario: An empty Flow shows a valid empty sketch (no error)
  test("an empty Flow yields the generator's empty sketch with no error", async () => {
    const emptySketch = "void setup() {}\nvoid loop() {}";
    let received: { nodes: unknown[]; edges: unknown[] } | undefined;
    const invoker: SketchInvoker = async (command) => {
      received = command.flow;
      return { success: true, data: emptySketch };
    };

    const state = await projectSketchResult(invoker, [], []);

    expect(received).toEqual({ nodes: [], edges: [] });
    expect(state).toEqual({ value: emptySketch, isError: false });
  });

  // Edge case: generation error surfaces as text, panel does not crash
  test("on failure the error string is surfaced as the editor value", async () => {
    const invoker: SketchInvoker = async () => ({
      success: false,
      error: "boom",
    });

    const state = await projectSketchResult(invoker, [NODE], []);

    expect(state.isError).toBe(true);
    expect(state.value).toContain("boom");
  });

  // Edge case: a missing data field still resolves to a stable empty value
  test("a success response without data resolves to an empty string", async () => {
    const invoker: SketchInvoker = async () => ({ success: true });

    const state = await projectSketchResult(invoker, [], []);

    expect(state).toEqual({ value: "", isError: false });
  });
});
