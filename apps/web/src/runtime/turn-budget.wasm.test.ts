// The turn budget lives in core, so the browser host gets it by construction —
// this pins that claim against the *compiled* wasm module rather than trusting
// it: a ring of Gates must return from `dispatch` (before the budget it never
// did, hanging the tab) with the loop attributed on the node badges.
//
// Needs the generated module: `bun run build:wasm:runtime`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Effects } from "@/lib/bindings/Effects";
import { FlowRuntime, initSync } from "./generated/microflow_runtime_wasm.js";

initSync({
  module: readFileSync(new URL("./generated/microflow_runtime_wasm_bg.wasm", import.meta.url)),
});

const node = (id: string) => ({
  id,
  type: "Gate",
  data: { gate: "or" },
  position: { x: 0, y: 0 },
});
const edge = (source: string, target: string) => ({
  id: `${source}-${target}`,
  source,
  sourceHandle: "true",
  target,
  targetHandle: "value",
});

describe("wasm runtime turn budget", () => {
  test("a ring of gates ends its turn and badges the loop", () => {
    const rt = new FlowRuntime();
    rt.updateFlow(
      JSON.stringify({ nodes: [node("a"), node("b")], edges: [edge("a", "b"), edge("b", "a")] }),
      0,
    );

    const effects = JSON.parse(rt.dispatch("a", "value", "true", 0)) as Effects;

    const badged = effects.nodeDiagnostics
      .filter((d) => d.level === "error" && d.message?.includes("loop"))
      .map((d) => d.node)
      .sort();
    expect(badged).toEqual(["a", "b"]);

    // The runtime is still alive and the paused loop stays quiet.
    const again = JSON.parse(rt.dispatch("a", "value", "true", 0)) as Effects;
    expect(again.componentEvents.length).toBeLessThan(10);
    rt.free();
  });
});
