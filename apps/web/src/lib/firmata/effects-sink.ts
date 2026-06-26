// The browser mirror of the core `EffectsSink` + `Effects::apply` (ADR-0008).
//
// The Rust↔TS boundary means the browser host cannot call into core's
// `Effects::apply`; instead it mirrors the same hook shape in the same canonical
// order. The order + the per-field handlers below are both typed exhaustive over
// `keyof Effects`, so a field added to the Rust `Effects` (regenerated into the
// wasm type) is a **compile error** here until it is ordered and handled — the
// browser can no longer silently drop a new field, the way the desktop sink
// can't (its Rust trait gains a required method). `__tests__/effects-sink.test.ts`
// remains the behavioural twin of the Rust `apply_tests`, asserting the order at
// runtime; the types now guarantee coverage so the test can't be the only guard.

import type { CloudRequest, Effects } from "@/lib/runtime/wasm";

export type { CloudRequest };
/** One scheduled wakeup, as carried in the `Effects` serde shape. */
export type Wakeup = Effects["wakeups"][number];
/** One emitted component event, as carried in the `Effects` serde shape. */
export type ComponentEvent = Effects["componentEvents"][number];

/**
 * The platform primitives an effects application drives — the TypeScript shape
 * of the Rust `EffectsSink`. The {@link FlowReactor} implements these (serial
 * write, `clearTimeout`, `setTimeout`, store ingest); {@link applyEffects}
 * sequences them. A new field that needs a new primitive adds a method here, via
 * the {@link EFFECT_HANDLERS} entry that would reference it — mirroring the
 * compile-time new-field guard the Rust `EffectsSink` trait gives the desktop.
 */
export interface EffectsSink {
  writeBytes(bytes: number[]): void;
  cancelWakeup(id: number): void;
  armWakeup(wakeup: Wakeup): void;
  performCloud(request: CloudRequest): void;
  dispatchEvent(event: ComponentEvent): void;
}

/**
 * One handler per `Effects` field. Typed `Record<keyof Effects, …>`, so adding a
 * field to the Rust `Effects` (regenerated into the wasm `Effects` type) is a
 * **compile error here** — a missing property — until it is handled, exactly the
 * way a new field breaks every Rust `EffectsSink` impl. This is the structural
 * guard that was previously only a conformance test: the browser can no longer
 * silently drop a new field (ADR-0008/0009).
 */
const EFFECT_HANDLERS: { [K in keyof Effects]: (fx: Effects, sink: EffectsSink) => void } = {
  outboundBytes: (fx, sink) => {
    if (fx.outboundBytes.length > 0) sink.writeBytes(fx.outboundBytes);
  },
  cancellations: (fx, sink) => {
    for (const id of fx.cancellations) sink.cancelWakeup(id);
  },
  wakeups: (fx, sink) => {
    for (const wakeup of fx.wakeups) sink.armWakeup(wakeup);
  },
  cloudRequests: (fx, sink) => {
    for (const request of fx.cloudRequests) sink.performCloud(request);
  },
  componentEvents: (fx, sink) => {
    for (const event of fx.componentEvents) sink.dispatchEvent(event);
  },
};

/**
 * The **canonical order** (ADR-0008, extended by ADR-0009) the fields apply in:
 * `outboundBytes → cancellations → wakeups → cloudRequests → componentEvents`.
 * Bytes first (wire latency), cancel-before-arm (so a cancel + re-arm of one
 * logical timer in a turn is safe), cloud launched before UI events leave, UI
 * events last (they leave the runtime and do not feed back this turn).
 *
 * `satisfies` pins every entry to a real field; {@link AssertOrderIsExhaustive}
 * below pins the *reverse* — a new field absent from this tuple fails to compile,
 * so the order can never silently lose a field either.
 */
const APPLY_ORDER = [
  "outboundBytes",
  "cancellations",
  "wakeups",
  "cloudRequests",
  "componentEvents",
] as const satisfies readonly (keyof Effects)[];

/** Errors unless {@link APPLY_ORDER} lists every key of `Effects` (the wrap in a
 *  1-tuple stops the conditional distributing, so `never` reads as covered). */
type AssertOrderIsExhaustive = [Exclude<keyof Effects, (typeof APPLY_ORDER)[number]>] extends [never]
  ? true
  : ["Effects field missing from APPLY_ORDER", Exclude<keyof Effects, (typeof APPLY_ORDER)[number]>];
const _orderIsExhaustive: AssertOrderIsExhaustive = true;

/**
 * Apply one turn's effects in the canonical order, driving one {@link EFFECT_HANDLERS}
 * entry per field. The order lives in {@link APPLY_ORDER}; the per-field work in
 * the handlers. Both are exhaustive over `keyof Effects`, so a new field is a
 * compile error until it is ordered *and* handled — the browser mirror of the
 * Rust `Effects::apply` + `EffectsSink` trait guard.
 */
export function applyEffects(fx: Effects, sink: EffectsSink): void {
  for (const field of APPLY_ORDER) EFFECT_HANDLERS[field](fx, sink);
}
