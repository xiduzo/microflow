# ADR-0044 — Declared, drawn and honoured handles are one set

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander
- **Extends:** [ADR-0007](0007-node-wire-interface-emit-contract.md), [ADR-0032](0032-live-handle-set-and-handle-pruning.md)

> **Decision:** a node's handles have one answer. What its component declares
> (`ports()` / `emits()`), what the editor draws for some setting of the node
> (its **Handle Rule**, read as the **Live Handle Set**), what the live runtime
> takes, and what the sketch generator honours are the same set of Ports and
> Emits. The exceptions are few, named, and each carries its reason in a
> guard: a Port the Runtime Host delivers (Hotkey `key_event`), a second name
> for a Port (Servo `rotate`), the implicit `value` Emit on a node whose output
> is a named Emit (or on Monitor), and open ports. Guards in both languages
> fail when a handle leaves the set on one side only.

## Context

[ADR-0007](0007-node-wire-interface-emit-contract.md) made the Rust consts the
one source of what a component declares, and
[ADR-0032](0032-live-handle-set-and-handle-pruning.md) made the Handle Rule the
one source of what a node offers. Nothing held the two together beyond "every
offered handle is declared". The other direction was a list in
`nodes/handles.test.ts` of declared handles no rule offered, and it had grown
into a record of disagreements:

- Button, Switch, Motion, Proximity and the Sensor family (Sensor, Force,
  HallEffect, Ldr, Potentiometer, Tilt) declared a `read` Port that did
  nothing. The editor did not draw it; the runtime accepted an edge into it
  without effect.
- Stepper `enable`, Matrix `reinitialize` and Llm `error` were declared and
  honoured, and not drawn, so no flow could use them from the canvas.
- Compare and Gate gave an Emit they do not declare, `event`, a value on the
  board.
- Relay and Piezo kept a value and did not draw `value`; Stepper declared a
  `value` Emit that was always 0.

Each of these is a handle that one reader sees and another does not: a user
cannot wire what the runtime would honour, or wires what it ignores.

## Decision

**D1 — One set.** For every node type, the declared Ports are the Ports some
setting of the node offers, and the runtime takes each of them (under some
setting) and refuses any other name. The sketch generator either generates
code for an edge into a declared Port or refuses it in so many words (a
`// note:` in the sketch), and generates nothing for an edge into an
undeclared one. The declared Emits are the Emits some setting offers, and no
undeclared Emit has a value on the board. A Port that does nothing is not
declared.

**D2 — The exceptions.** Only these differ, and each is listed in a guard with
its reason:

- **A host-delivered Port.** Hotkey `key_event`: the Runtime Host dispatches a
  key press on it; no edge ever does. It is declared, not drawn, and skipped by
  the sketch check (a board has no keyboard).
- **An alias.** Servo `rotate`: a second name for `value` on a continuous servo.
  The runtime and the sketch honour it so that an edge stored at it keeps
  driving the servo; the editor does not draw it.
- **The implicit `value` Emit.** Every component that keeps a value emits it on
  `value` (`ComponentBase::set_value`). A node may leave `value` off the
  canvas only when it draws a named Emit that carries its output
  (`NAMED_OUTPUTS`: Button, Hotkey, Motion, Switch, Compare, Gate, RangeMap,
  Trigger, Figma, Pixel); otherwise it is listed in `VALUE_NOT_DRAWN` with a
  reason. Monitor is the one such node: a display at the end of a flow, which
  draws no Emit at all.
- **Open ports.** A Port named by the node's settings (a Function or Llm
  `{{variable}}`, a Music record) is offered and taken under any name, and no
  closed list holds it ([ADR-0032](0032-live-handle-set-and-handle-pruning.md)).
- **No sketch.** Note, Pn532 and Music are exported as a placeholder comment,
  so the sketch checks skip them.

**D3 — The guards.** Each states one part of D1 and fails on a new handle that
breaks it.

- *Compile time.* A Handle Rule's Port ids are `PortOf<T>` and its Emit ids
  `EmitOf<T>` (`nodes/_base/handle-rule.ts`), so a rule cannot offer a handle
  the component does not declare, open ports aside.
- *`apps/web/src-tauri/tests/catalog_parity.rs`.* The committed
  `wire-interface.generated.json`, from which `COMPONENT_PORTS` /
  `COMPONENT_EMITS` are generated, matches every component's `ports()` /
  `emits()`.
- *`apps/web/src/nodes/handles.test.ts`*, "the live set and the wire
  interface": without open ports every handle a rule offers is declared; every
  declared Port is offered by some setting except those in `PORTS_NOT_OFFERED`
  (Hotkey `key_event`, Servo `rotate`), each with a reason; every declared
  Emit is offered by some setting except `value` on the types in
  `NAMED_OUTPUTS` or `VALUE_NOT_DRAWN`; a type in `NAMED_OUTPUTS` offers some
  Emit, and a type in `VALUE_NOT_DRAWN` offers none and gives a reason.
- *`crates/microflow-core/src/codegen/parity.rs`*, driven from the live
  `ComponentRegistry` so a new node cannot skip them:
  `every_declared_port_reaches_the_sketch_or_is_refused_in_it`;
  `the_sketch_honours_no_port_a_component_does_not_declare`;
  `only_a_declared_emit_has_an_on_device_value`;
  `every_declared_emit_has_an_on_device_value_or_a_reasoned_refusal`
  ([ADR-0013](0013-handle-aware-sketch-wiring.md)); and
  `the_runtime_takes_its_declared_ports_and_refuses_any_other`. The names that
  `the_sketch_honours_…`, `only_a_declared_emit_…` and `the_runtime_takes_…`
  try are every declared name plus `read`.

## Considered options

- **Keep a list of declared handles left undrawn, without reasons.** That is
  the list that grew; a list entry said nothing about whether the handle
  worked.
- **Draw every declared handle, the aliases and host Ports included.** A user
  would see a `key_event` input no edge can drive and two inputs on a Servo
  that do the same.
- **Keep the no-op `read` Port for flows that wired it.** An edge into it did
  nothing; keeping it would keep a handle that suggests a behaviour the node
  does not have.

## Consequences

- A stored edge into a removed `read` Port (Button, Switch, Motion, Proximity,
  Sensor, Force, HallEffect, Ldr, Potentiometer, Tilt) is kept in the
  document. Live, a value arriving on it is refused and the node shows a
  rejected-input warning (`Input "read" failed: …`) until the edge is gone. A
  flow file holding one decodes with an `unknown-handle` notice
  ([ADR-0041](0041-flow-file-is-a-load-boundary.md)). The canvas cannot draw
  it, and handle pruning never removes it, since the handle never vanishes
  ([ADR-0032](0032-live-handle-set-and-handle-pruning.md)).
- Adding a Port or Emit in Rust means drawing it in the node's Handle Rule and
  binding it in the node's `codegen.rs` (or refusing it there with a note).
- Removing a handle that stored flows use costs those flows their edge, with
  the warning and the notice above. It is a visible change, not a silent one.

## What this does NOT decide

- What value a declared Emit carries on the board. Every declared Emit has
  one or a reasoned refusal ([ADR-0013](0013-handle-aware-sketch-wiring.md));
  the guard here says only that no undeclared Emit has one.
- Whether Monitor should draw its `value`.
- How a node lays out its handles.

## References

- `apps/web/src/nodes/handles.test.ts` — `PORTS_NOT_OFFERED`, `NAMED_OUTPUTS`, `VALUE_NOT_DRAWN`.
- `crates/microflow-core/src/codegen/parity.rs` — `host_delivered`, `has_open_ports`, `has_no_emitter`, and its guards.
- `apps/web/src-tauri/tests/catalog_parity.rs` — `wire_interface_sidecar_matches_rust`.
- `apps/web/src/nodes/_base/handle-rule.ts` — `PortSpec`, `EmitSpec`.
- `crates/microflow-core/src/runtime/mod.rs`, `runtime/health.rs` — a rejected input on the node's badge.
- `CONTEXT.md` § Port, Emit, Live Handle Set.
