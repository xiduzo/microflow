// The browser mirror of the core `EffectsSink` + `Effects::apply` (ADR-0008).
//
// The Rust↔TS boundary means the browser host cannot call into core's
// `Effects::apply`; instead it mirrors the same four-hook shape in the same
// canonical order. The shared *order* — not shared code — is the contract, and
// `__tests__/effects-sink.test.ts` is the browser half of the conformance
// scenario that holds this in lockstep with the Rust `apply_tests`.

import type { CloudRequest, Effects } from "@/lib/runtime/wasm";

export type { CloudRequest };
/** One scheduled wakeup, as carried in the `Effects` serde shape. */
export type Wakeup = Effects["wakeups"][number];
/** One emitted component event, as carried in the `Effects` serde shape. */
export type ComponentEvent = Effects["componentEvents"][number];

/**
 * The four platform primitives an effects application drives — the TypeScript
 * shape of the Rust `EffectsSink`. The {@link FlowReactor} implements these
 * (serial write, `clearTimeout`, `setTimeout`, store ingest); {@link applyEffects}
 * sequences them. A new `Effects` field adds a method here, mirroring the
 * compile-time new-field guard the Rust trait gives the desktop sink.
 */
export interface EffectsSink {
  writeBytes(bytes: number[]): void;
  cancelWakeup(id: number): void;
  armWakeup(wakeup: Wakeup): void;
  performCloud(request: CloudRequest): void;
  dispatchEvent(event: ComponentEvent): void;
}

/**
 * Apply one turn's effects in the **canonical order** (ADR-0008, extended by
 * ADR-0009), mirroring the Rust `Effects::apply`: `outboundBytes → cancellations
 * → wakeups → cloudRequests → componentEvents`. Bytes first (wire latency),
 * cancel-before-arm (so a cancel + re-arm of the same logical timer in one turn
 * is safe), cloud calls launched before UI events leave, UI events last (they
 * leave the runtime and do not feed back this turn).
 */
export function applyEffects(fx: Effects, sink: EffectsSink): void {
  if (fx.outboundBytes.length > 0) sink.writeBytes(fx.outboundBytes);
  for (const id of fx.cancellations) sink.cancelWakeup(id);
  for (const wakeup of fx.wakeups) sink.armWakeup(wakeup);
  for (const request of fx.cloudRequests) sink.performCloud(request);
  for (const event of fx.componentEvents) sink.dispatchEvent(event);
}
