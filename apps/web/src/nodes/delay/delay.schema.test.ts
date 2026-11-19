import { describe, expect, test } from "bun:test";
import { TEMPLATES } from "@/flows/templates";
import { resolveNodeData } from "@/nodes/node-data-resolver";
import { dataSchema, defaults } from "./delay.schema";

// `forgetPrevious` picks what a Delay does with a signal that arrives while
// another is still waiting: off, both are passed on (a queue); on, the new one
// replaces the waiting one (debounce). What each does at run time is pinned in
// Rust, live and in the sketch (`crates/microflow-core/src/nodes/delay`); this
// pins which of the two a node the app creates or ships is.

function delayOf(templateId: string) {
  const template = TEMPLATES.find((candidate) => candidate.id === templateId);
  const node = template?.nodes.find((candidate) => candidate.type === "Delay");
  if (!node) throw new Error(`template ${templateId} has no Delay`);
  return dataSchema.parse(node.data);
}

describe("which Delay the app makes", () => {
  test("a new Delay passes every signal on", () => {
    expect(defaults.forgetPrevious).toBe(false);
  });

  test("a Delay stored without the setting passes every signal on", () => {
    expect(dataSchema.parse({ delay: 250 }).forgetPrevious).toBe(false);
    const resolved = resolveNodeData("Delay", { delay: 250 });
    expect(resolved.ok && resolved.data).toMatchObject({ delay: 250, forgetPrevious: false });
  });
});

describe("the Delays in the built-in templates", () => {
  test("Debounced Button debounces: 30 ms, only the last signal", () => {
    expect(delayOf("debounce-button")).toMatchObject({ delay: 30, forgetPrevious: true });
  });

  test("Motion Alarm sounds once per motion signal, half a second late", () => {
    expect(delayOf("motion-alarm")).toMatchObject({ delay: 500, forgetPrevious: false });
  });
});
