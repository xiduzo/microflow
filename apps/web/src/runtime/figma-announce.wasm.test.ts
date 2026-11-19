// The Figma Announce Policy lives in core (`figma_announce_actions`), and the
// browser's CloudPerformer gets it through the wasm binding. This runs the
// *compiled* module over the shared table of transitions, the same table the
// CloudPerformer tests hold their TypeScript twin of the policy to
// (`cloud/cloud-performer.test.ts`): the twin cannot drift from what the
// browser really publishes without one of the two failing.
//
// Needs the generated module: `bun run build:wasm:runtime`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FIGMA_ANNOUNCE_CASES } from "@/lib/figma-announce-cases";
import { initSync } from "./generated/microflow_runtime_wasm.js";
import { figmaAnnounceActions } from "./wasm";

initSync({
  module: readFileSync(new URL("./generated/microflow_runtime_wasm_bg.wasm", import.meta.url)),
});

describe("wasm figmaAnnounceActions", () => {
  for (const { name, prev, next, publishes } of FIGMA_ANNOUNCE_CASES) {
    test(name, () => {
      expect(figmaAnnounceActions(prev, next)).toEqual(publishes);
    });
  }
});
