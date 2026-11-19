// Every built-in template must export: an Author who starts from one and opens
// the Code view gets a sketch, not "Cannot generate a sketch". Sketch
// generation refuses a Flow with a node whose settings it cannot read, so a
// template whose `data` the Rust config does not accept would fail here.
//
// Runs the *compiled* generator, the one the browser runs. Needs the generated
// module: `bun run build:wasm:codegen`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { GenerationOutcome } from "@/lib/bindings/GenerationOutcome";
import { TEMPLATES } from "@/flows/templates";
import { generate_sketch, initSync } from "./generated/microflow_codegen_wasm.js";

initSync({
  module: readFileSync(new URL("./generated/microflow_codegen_wasm_bg.wasm", import.meta.url)),
});

describe("templates export as sketches", () => {
  // The ESP32 fits every template: some use Cloud Nodes, which need networking.
  for (const template of TEMPLATES) {
    test(template.name, () => {
      const flow = JSON.stringify({ nodes: template.nodes, edges: template.edges });
      const outcome = JSON.parse(generate_sketch(flow, "esp32", undefined)) as GenerationOutcome;

      const errors = outcome.problems.filter((problem) => problem.severity === "error");
      expect(errors.map((problem) => problem.message)).toEqual([]);
      expect(outcome.sketch).toContain("void setup()");
    });
  }

  test("a node whose settings cannot be read is named, with the setting", () => {
    const flow = JSON.stringify({
      nodes: [{ id: "led-1", type: "Led", data: { pin: "left" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const outcome = JSON.parse(generate_sketch(flow, "uno", undefined)) as GenerationOutcome;
    expect(outcome.sketch).toBeNull();
    expect(outcome.problems.map((problem) => problem.message)).toEqual([
      "Node led-1 (Led): its settings could not be read (pin: invalid pin: left)",
    ]);
  });
});
