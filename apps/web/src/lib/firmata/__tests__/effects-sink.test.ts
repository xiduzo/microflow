import { describe, expect, test } from "bun:test";
import {
  applyEffects,
  type CloudRequest,
  type ComponentEvent,
  type EffectsSink,
  type Wakeup,
} from "../effects-sink";
import type { Effects } from "@/lib/runtime/wasm";

// The browser half of the ADR-0008 conformance scenario. Its Rust twin is
// `microflow-core`'s `context::apply_tests` — both assert the same canonical
// order (bytes → cancel → arm → event) and that nothing double-fires, so the
// two hosts cannot silently drift the way `apply` already did once.

/** Records each hook call as a tag so order is a plain array assertion. */
class Recorder implements EffectsSink {
  readonly calls: string[] = [];
  writeBytes(bytes: number[]): void {
    this.calls.push(`write:${bytes.length}`);
  }
  cancelWakeup(id: number): void {
    this.calls.push(`cancel:${id}`);
  }
  armWakeup(wakeup: Wakeup): void {
    this.calls.push(`arm:${wakeup.id}`);
  }
  performCloud(request: CloudRequest): void {
    this.calls.push(`cloud:${request.source}`);
  }
  dispatchEvent(event: ComponentEvent): void {
    this.calls.push(`event:${event.sourceHandle}`);
  }
}

function event(sourceHandle: string): ComponentEvent {
  return { source: "n", sourceHandle, value: true, edgeId: null, sequence: 0 };
}

describe("applyEffects (ADR-0008 canonical order)", () => {
  test("drives hooks in order bytes → cancel → arm → cloud → event, no double-fire", () => {
    const fx: Effects = {
      outboundBytes: [0x90, 0x01, 0x00],
      componentEvents: [event("value")],
      wakeups: [{ id: 9, nodeId: "t", method: "_tick", delayMs: 100 }],
      cancellations: [7],
      cloudRequests: [
        {
          source: "llm",
          kind: "llmGenerate",
          providerId: "p",
          model: "m",
          system: null,
          prompt: "hi",
        },
      ],
    };

    const rec = new Recorder();
    applyEffects(fx, rec);

    expect(rec.calls).toEqual(["write:3", "cancel:7", "arm:9", "cloud:llm", "event:value"]);
  });

  test("skips writeBytes when there are no outbound bytes", () => {
    const fx: Effects = {
      outboundBytes: [],
      componentEvents: [event("value")],
      wakeups: [],
      cancellations: [],
      cloudRequests: [],
    };

    const rec = new Recorder();
    applyEffects(fx, rec);

    expect(rec.calls).toEqual(["event:value"]);
  });
});
