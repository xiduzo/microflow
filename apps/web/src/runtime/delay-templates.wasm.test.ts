// The built-in templates that hold a Delay, run as stored on the *compiled*
// runtime the browser runs: Debounced Button must still pass a bouncing press
// on once, and Motion Alarm sounds once per motion signal.
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

type Emitted = { at: number; from: string; value: unknown };

/** The Runtime Host role for one template: its wakeups kept on a clock the
 *  test advances, and what its nodes emitted, with the time. */
function run(templateId: string) {
  const template = TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) throw new Error(`no template ${templateId}`);
  const runtime = new FlowRuntime();
  const timers = new Map<number, { due: number; nodeId: string; method: string }>();
  const emitted: Emitted[] = [];
  let now = 0;

  const apply = (json: string) => {
    // A turn with nothing for the host to do comes back as the empty string.
    if (json === "") return;
    const effects = JSON.parse(json) as Effects;
    for (const id of effects.cancellations) timers.delete(id);
    for (const wakeup of effects.wakeups) {
      timers.set(wakeup.id, { due: now + wakeup.delayMs, nodeId: wakeup.nodeId, method: wakeup.method });
    }
    for (const event of effects.componentEvents) {
      emitted.push({ at: now, from: `${event.source}.${event.sourceHandle}`, value: event.value });
    }
  };

  apply(runtime.updateFlow(JSON.stringify({ nodes: template.nodes, edges: template.edges }), now));
  return {
    /** What `from` (`node.handle`) emitted so far: `[at ms, value]`. */
    emittedBy: (from: string) => emitted.filter((event) => event.from === from).map((event) => [event.at, event.value]),
    trigger(nodeId: string, value: unknown) {
      apply(runtime.dispatch(nodeId, "trigger", JSON.stringify(value), now));
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= until).sort(([, a], [, b]) => a.due - b.due)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.due;
        apply(runtime.wake(timer.nodeId, timer.method, now));
      }
      now = until;
    },
    free: () => runtime.free(),
  };
}

describe("templates with a Delay, on the wasm runtime", () => {
  test("Debounced Button counts a bouncing press once", () => {
    const flow = run("debounce-button");

    // Five edges of one bouncing contact, all inside the 30 ms window.
    for (const gap of [0, 4, 5, 6, 8]) {
      flow.advance(gap);
      flow.trigger("delay-1", true);
    }
    flow.advance(1000);

    // 23 ms in for the last edge, 30 ms more for the Delay.
    expect(flow.emittedBy("delay-1.event")).toEqual([[53, true]]);
    expect(flow.emittedBy("counter-1.value")).toEqual([[53, 1]]);
    flow.free();
  });

  test("Motion Alarm passes every motion signal on, half a second late", () => {
    const flow = run("motion-alarm");

    flow.trigger("delay-1", true);
    flow.advance(100);
    flow.trigger("delay-1", false);
    flow.advance(250);
    flow.trigger("delay-1", true);
    flow.advance(1000);

    expect(flow.emittedBy("delay-1.event")).toEqual([
      [500, true],
      [600, false],
      [850, true],
    ]);
    flow.free();
  });
});
