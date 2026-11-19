// The built-in templates that hold a Delay, exported as stored by the
// *compiled* generator the browser runs: Debounced Button's Delay must still
// be the one-slot (debounce) Delay, Motion Alarm's the one that holds every
// signal. What each shape does when the sketch runs is pinned in Rust
// (`crates/microflow-core/tests/delay_sketch.rs`).
//
// Needs the generated module: `bun run build:wasm:codegen`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { GenerationOutcome } from "@/lib/bindings/GenerationOutcome";
import { TEMPLATES } from "@/flows/templates";
import { generate_sketch, initSync } from "./generated/microflow_codegen_wasm.js";

initSync({
  module: readFileSync(new URL("./generated/microflow_codegen_wasm_bg.wasm", import.meta.url)),
});

function sketchOf(templateId: string): string {
  const template = TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) throw new Error(`no template ${templateId}`);
  const flow = JSON.stringify({ nodes: template.nodes, edges: template.edges });
  const outcome = JSON.parse(generate_sketch(flow, "uno", undefined)) as GenerationOutcome;
  if (outcome.sketch === null) throw new Error(`no sketch: ${JSON.stringify(outcome.problems)}`);
  return outcome.sketch;
}

describe("templates with a Delay, as sketches", () => {
  test("Debounced Button holds one signal, which each new one overwrites", () => {
    const sketch = sketchOf("debounce-button");

    expect(sketch).toContain("double delay_delay_1_stored = 0.0;");
    expect(sketch).toContain("if (delay_delay_1_pending && millis() - delay_delay_1_armed_at >= 30UL) {");
    expect(sketch).not.toContain("delay_delay_1_stored[");
  });

  test("Motion Alarm holds every signal, oldest first", () => {
    const sketch = sketchOf("motion-alarm");

    expect(sketch).toContain("double delay_delay_1_stored[16];");
    expect(sketch).toContain(
      "if (delay_delay_1_pending > 0 && millis() - delay_delay_1_armed_at[delay_delay_1_head] >= 500UL) {",
    );
  });
});
