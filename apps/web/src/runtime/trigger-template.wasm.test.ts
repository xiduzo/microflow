// The built-in template that holds a Trigger, run as stored on the *compiled*
// runtime the browser runs: Edge Trigger Alarm sounds once per sharp rise of
// the reading, timed on the clock the host hands in.
//
// Needs the generated module: `bun run build:wasm:runtime`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TEMPLATES } from "@/flows/templates";
import type { Effects } from "@/lib/bindings/Effects";
import { FlowRuntime, initSync } from "./generated/microflow_runtime_wasm.js";

initSync({
  module: readFileSync(new URL("./generated/microflow_runtime_wasm_bg.wasm", import.meta.url)),
});

/** The Runtime Host role for one template: a clock the test sets, and what
 *  the Trigger banged, with the time. */
function run(templateId: string) {
  const template = TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) throw new Error(`no template ${templateId}`);
  const runtime = new FlowRuntime();
  const bangs: [number, unknown][] = [];

  const apply = (json: string, now: number) => {
    // A turn with nothing for the host to do comes back as the empty string.
    if (json === "") return;
    const effects = JSON.parse(json) as Effects;
    for (const event of effects.componentEvents) {
      if (event.source === "trigger-1" && event.sourceHandle === "bang") bangs.push([now, event.value]);
    }
  };

  apply(runtime.updateFlow(JSON.stringify({ nodes: template.nodes, edges: template.edges }), 0), 0);
  return {
    bangs,
    /** The reading reaches the Trigger at `now` ms. */
    reading(now: number, value: number) {
      apply(runtime.dispatch("trigger-1", "value", JSON.stringify(value), now), now);
    },
    free: () => runtime.free(),
  };
}

describe("the template with a Trigger, on the wasm runtime", () => {
  test("Edge Trigger Alarm bangs once per rise of 50 within a quarter second", () => {
    const flow = run("edge-trigger");

    flow.reading(0, 100);
    flow.reading(100, 120);
    flow.reading(200, 180); // 80 above the 100 of 200 ms before
    flow.reading(300, 240); // still rising: no second bang
    flow.reading(1300, 200); // alone in its window: ready again
    flow.reading(1400, 400);

    expect(flow.bangs).toEqual([
      [200, 180],
      [1400, 400],
    ]);
    flow.free();
  });

  test("a rise spread over more than the window does not bang", () => {
    const flow = run("edge-trigger");

    flow.reading(0, 100);
    flow.reading(200, 130);
    flow.reading(251, 160); // 60 above the 100, but that is 251 ms old

    expect(flow.bangs).toEqual([]);
    flow.free();
  });
});
