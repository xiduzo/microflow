# Context — Domain Language

Living glossary. Keep aligned with code. Update when terms shift.

## Component Catalog

The single source of truth for every flow component the UI exposes and the runtime executes. Lives at `apps/web/node-components.json`. Has two arrays:

- **`entries`** — UI-visible component names. Each row is one item the user can drop on the canvas. The `name` is also the value of `data.instance` in Yjs / ReactFlow. Variants (e.g. `Potentiometer`) are entries that point at another impl.
- **`impls`** — the runtime classes the Rust runtime knows how to construct. Each row carries `category` (a grouping label, see § Category) and `requiresHardware` (whether `BoardHandle::initialize` is called).

### Fields

| Field                      | Where           | Meaning                                                                                                |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `entries[].name`           | UI + Yjs        | Instance string used as ReactFlow node type and `data.instance`.                                       |
| `entries[].impl`           | runtime mapping | The `impls` row this entry resolves to. May be the entry's own name, or a parent impl for variants.    |
| `impls[].name`             | Rust            | The Rust struct name (also derives `<Name>Config`).                                                    |
| `impls[].category`         | catalog label   | `input`, `output`, `control`, `transformation`, `generator`, `external`. Not a Rust module path (see § Category). |
| `impls[].requiresHardware` | Rust            | If true, registry calls `Component::initialize(board)` when board connected.                           |
| `<Impl>::ports()` / `emits()` | Rust (source)   | The declared **Port** / **Emit** sets — the single source of truth. Not catalog fields: generated from the Rust consts into `wire-interface.generated.json`, thence `COMPONENT_PORTS`/`COMPONENT_EMITS` + `PortOf<T>`/`EmitOf<T>`. What a node offers of them for its settings is its [Live Handle Set](#live-handle-set). See § Port / § Emit / § Generation. |

### Generation

The catalog drives the frontend; the **wire interface flows the other way**, from Rust:

- `apps/web/scripts/codegen-node-registry.ts` reads `entries` from the catalog **and** the Port/Emit sets from `apps/web/wire-interface.generated.json`, then writes three files under `apps/web/src/nodes/`: `component-types.generated.ts`; `catalog.generated.ts` (`NODE_CATALOG` — per-type `defaults`, `schema` and host `adapter`; React-free, for non-UI code); and `node-types.generated.ts` (`NODE_TYPES` — the React component per type, for ReactFlow). It also writes `apps/web/node-defaults.generated.json` (`scripts/node-defaults.ts`): what the editor can write into each entry's `data`, read off the entry's zod schema — a new node's `defaults` (without the presentation keys), the defaults of each member of a schema that is a union (`variants`, e.g. Piezo's buzz/song — not catalog [Variants](#variant)), and every value of every enum field (`options`). Run via `bun run codegen` in `apps/web`; `scripts/node-defaults.test.ts` fails on a stale file, so a schema edit needs a re-run.
- `apps/web/wire-interface.generated.json` is generated **from Rust** `<Impl>::ports()`/`emits()` by the **Catalog Parity Guard** (`apps/web/src-tauri/tests/catalog_parity.rs`) when run with `BLESS_WIRE_INTERFACE=1`; otherwise the same guard asserts the committed file is current, so a stale mirror fails CI rather than shipping wrong handle types. `bun run catalog:sync` (in `apps/web`) runs three steps: bless the wire interface from Rust, `bun run codegen`, then the whole [Catalog Parity Guard](#catalog-parity-guard) — its config half reads the `node-defaults.generated.json` that codegen just wrote. Port/Emit thus have **one** source — the compile-checked Rust consts — and no hand-authored catalog mirror to drift.
- `apps/web/src-tauri/build.rs` generates nothing (it is `tauri_build::build()`); the `ComponentRegistry` hand-registers nodes in `register_all` (`crates/microflow-core/src/runtime/registry.rs`, [ADR-0006](docs/adr/0006-rehost-runtime-on-core.md)).

## Component Registry

The Rust-side runtime view of the Component Catalog. Holds factory closures keyed by `entries[].name`. Built once at runtime construction; queried by `FlowRuntime::update_flow` to instantiate `Box<dyn Component>` per flow node.

## Catalog Parity Guard

The test that holds the TypeScript and Rust halves of every [Component Catalog](#component-catalog) entry together: `apps/web/src-tauri/tests/catalog_parity.rs`, in the desktop crate because that is the one place every core feature is enabled, so `ComponentRegistry::declared()` is the complete node set ([ADR-0007](docs/adr/0007-node-wire-interface-emit-contract.md), [ADR-0033](docs/adr/0033-one-node-config-resolution.md)). Two halves:

- **Wire interface** (Rust is the source) — generates `wire-interface.generated.json` from `ports()`/`emits()` under `BLESS_WIRE_INTERFACE=1`, otherwise asserts the committed file is current; asserts the registered names equal the catalog's `entries[].name`.
- **Node config** (the editor's `data` is the contract) — feeds everything in `node-defaults.generated.json` through [Node config resolution](#node-config-resolution) and fails when the runtime cannot build an entry from it or the export refuses it; when an editor default differs from the Rust config's own default and is not recorded, with its reason, in `DELIBERATE_DIFFERENCES`; when a config field is spelled differently from what the editor writes (the serde `rename_all = "camelCase"` trap, where the field silently keeps its default); or when a fraction or an out-of-range number in an integer setting does not mean the same to both halves.

Run by `bun run catalog:sync` and by `cargo test` on the desktop crate. Distinct from `crates/microflow-core/src/codegen/parity.rs`, which checks that each Node's emitted C++ does what its runtime does.

## Variant

An `entries` row whose `impl` differs from its `name`. Reuses the parent impl's runtime behavior, TS schema and [Handle Rule](#handle-rule). Examples: `Potentiometer`/`Force`/`Ldr`/`HallEffect`/`Tilt` over `Sensor`; `Vibration` over `Led`. Variants may override TS defaults (label, group, icon, subType, or a setting: Tilt's `threshold` is 10) but cannot change runtime behavior — their factory delegates to the parent impl class.

## Category

A grouping label on an `impls` row. No Rust path follows from it: a Node's Rust code lives in its **Node Vertical**, `crates/microflow-core/src/nodes/<node>/` — `config.rs` (ungated; read by both other layers through [Node config resolution](#node-config-resolution)), `runtime.rs` (behind `runtime`, or `cloud` / `js`) and `codegen.rs` (ungated), only the layers that Node has ([ADR-0026](docs/adr/0026-node-code-colocated-per-node.md)). Distinct from TS-side `defaults.group` (which is a freeform UI grouping label).

## Node config resolution

The one step from a Node's `data` to its config: `config::resolve::<C>(data)` in `crates/microflow-core/src/config/mod.rs` (ungated, [ADR-0033](docs/adr/0033-one-node-config-resolution.md)). Both halves of the engine read through it — the `ComponentRegistry` when it builds a Node (interpret), every Arduino emitter that has settings before it writes C++ (emit) — so they cannot disagree about what a Node's settings mean, or about whether they can be read. The shape the editor writes is the contract: a missing field takes the config's own serde default, a field the config does not know is ignored, and a present field that does not fit makes an [Unreadable config](#unreadable-config). How a number is read sits next to it in `config/serde_utils.rs`: a whole-number setting (`deserialize_whole`) rounds a JSON number to the nearest whole number, halves away from zero, and refuses a value its type cannot hold; a pin (`deserialize_pin_u8`) is a name — `13`, `13.0` and `"13"` are pin 13, `13.4` is refused; an analog pin (`deserialize_analog_pin`) is `"A0"`-style or a pin number, kept as a `PinLabel`. Not the [Node Data Resolver](#node-data-resolver), which builds a schema-valid `data` on the TypeScript side; this reads one.

## Unreadable config

A Node `data` that [Node config resolution](#node-config-resolution) cannot read: `UnreadableConfig` (`crates/microflow-core/src/config/mod.rs`). It displays as the setting and the reason — `pin: invalid pin: left`, `pins.red: pin out of range: 300` — or the reason alone when no single setting can be named. The same fact on both sides, and neither substitutes defaults: live it is [Node health](#node-health) ("Not running: its settings could not be read (…)", from `RuntimeError::ConfigDeserialize`); on export it is an error-severity `ValidationProblem` naming the Node (`codegen::validate::unreadable_config`), and no Sketch is generated. Such a Node has no pin demands, so neither sketch validation nor the live pin check judges a pin it does not have. Not a missing field (that is a default) and not a pin the board cannot serve (that is the pin check).

## Debounce window

The quiet time, `config::DEBOUNCE_MS` (50 ms, `crates/microflow-core/src/config/mod.rs`), by which a digital input (Button, Switch) settles its contacts: an edge that comes within 50 ms of the previous one waits until the line has held quiet that long, and a clean edge after a quiet line is taken at once. The live node and its emitted sketch (`codegen::emit::debounced_read`) settle by the same window. It is longer than one 50 Hz mains period, so a floating pin's hum is not taken for presses.

## Ranging

How a Proximity controller turns a raw analog reading (0–1023) into centimetres: `Ranging` from `ProximityConfig::ranging()` (`crates/microflow-core/src/nodes/proximity/config.rs`), read by the live node and its emitted sketch alike. A Sharp infrared controller (GP2Y0A21YK, GP2Y0A02YK0F) follows its voltage curve, kept between its nearest and farthest distance; HCSR04 is linear; any other controller (GP2Y0A710K0F among the editor's options) scales the reading to 0–200 cm. A Proximity hands on a distance only when it moved more than `MIN_MOVE_CM` (1 cm) from the last one it handed on.

## Component (Rust trait)

In `crates/microflow-core/src/runtime/component.rs`. The interface every impl satisfies. Decision and migration captured in `docs/adr/0001-component-trait-flow-separation.md` (see also `docs/audits/RUNTIME_AUDIT_APRIL_2026.md` §3.5 / §3.3). Three distinct flows enter the trait, each with its own method:

- **Port** — edge inputs. Delivered via `dispatch(&str, ComponentValue)`. Each impl declares its accepted Port set via `fn ports() -> &'static [&'static str] where Self: Sized`.
- **Internal Event** — self-routed methods. Delivered via `dispatch_internal(&str, ComponentValue)`.
- **Hardware Callback** — board-reader-driven events. Delivered via `HardwareComponent::on_pin_change` / `on_i2c_reply`.

The shared underscore-prefix routing in `runtime/mod.rs::process_event` dispatches to the right method based on the reserved handle name; everything else is a Port.

## Port

A named edge-input slot on a **Component (Rust trait)**, delivered as `target_handle` from a flow edge into `Component::dispatch`. Each impl declares its closed Port set via `fn ports() -> &'static [&'static str]`. The set is the **single source of truth** for the wire interface: the live **Catalog Parity Guard** ([ADR-0007](docs/adr/0007-node-wire-interface-emit-contract.md)) generates it — ports **and** Emits — from the Rust consts into `wire-interface.generated.json`. The frontend codegen (`apps/web/scripts/codegen-node-registry.ts`) reads that file to emit `COMPONENT_PORTS` (a typed const object) and `PortOf<T>` (a literal-union helper) into `component-types.generated.ts`, so the Port ids in a node's [Handle Rule](#handle-rule) are type-checked against the same Rust source. Empty array for components with no edge inputs (e.g. `Constant`).

Examples: `Led` accepts `"true"/"false"/"toggle"/"value"`; `Stepper` accepts `"value"/"to"/"stop"/"zero"/"enable"`; `Button` accepts none: it is an input, and receives its digital pin as a Hardware Callback via `on_pin_change`.

Distinct from **Emit** names (edge *outputs*), **Internal Event** names (never on edges, self-routed only), and **Hardware Callback** names (never on edges, runtime-delivered only). A declared Port is what the component accepts for any settings; which Ports a node offers for connection as it is configured is its [Live Handle Set](#live-handle-set).

## Emit

A named edge-**output** slot on a **Component (Rust trait)** — the `source_handle` a component emits on, delivered to the **FlowRouter** for fanout. The symmetric counterpart of **Port**. Each impl declares its closed Emit set via `fn emits() -> &'static [&'static str]` — the single source — generated from Rust into `wire-interface.generated.json` and thence to the frontend as `COMPONENT_EMITS` / `EmitOf<T>` (so the Emit ids in a node's [Handle Rule](#handle-rule) are type-checked against the same Rust source). Decision in [ADR-0007](docs/adr/0007-node-wire-interface-emit-contract.md).

Emit handles are compile-checked on the Rust side: each impl declares its handles as associated `const`s (e.g. `Button::E_EVENT`) referenced at every emit site **and** in `emits()`; a mistyped emit does not compile. The implicit `"value"` emit — fired by `ComponentBase::set_value` whenever the value changes — is centralized as `ComponentBase::VALUE_HANDLE` and listed in `emits()` by every value-emitting node. Examples: `Button` emits `"event"/"true"/"false"/"hold"/"value"`; `Compare`/`Gate` emit `"true"/"false"/"value"`; `Llm` emits `"thinking"/"value"/"done"/"error"`; value-only sinks emit just `"value"`.

Excludes `_`-prefixed **Internal Event** / wakeup names (e.g. `_hold`, `_tick`) — those are self-routed and never appear on an edge. The **Catalog Parity Guard** (`apps/web/src-tauri/tests/catalog_parity.rs`) generates `emits()` into `wire-interface.generated.json` and asserts the committed file is current.

**`emits()` is what a node can offer over all its settings.** For its current settings the editor offers the part in the node's [Live Handle Set](#live-handle-set). Every declared Emit is offered by some setting, except the implicit `value`: a node may leave `value` off only when it draws a named Emit that carries its output (`NAMED_OUTPUTS` in `apps/web/src/nodes/handles.test.ts`, e.g. `Button` → `event`/`true`/`false`/`hold`, `Gate` → `true`/`false`), or when it is listed in `VALUE_NOT_DRAWN` with a reason (`Monitor`, a display at the end of a flow). `apps/web/src/nodes/handles.test.ts` guards both directions: every handle a [Handle Rule](#handle-rule) can offer, open ports aside, is a declared **Port**/**Emit**, so a renamed Rust handle cannot outlive its UI; and every declared handle is offered by some setting, except the ones listed there with a reason, so a new Rust handle fails it until a rule offers it ([ADR-0044](docs/adr/0044-declared-drawn-and-honoured-handles-are-one-set.md)).

## Internal Event

Self-routed method delivered when a **Component (Rust trait)** emits a `ComponentEvent` whose `source_handle` starts with `_` and is not a reserved **Hardware Callback** name. The executor (`runtime/mod.rs::process_event`) strips the leading `_` and calls `Component::dispatch_internal` on the source component. Used by components that schedule their own state transitions (e.g. `Piezo` `auto_stop` after a song-playback thread finishes). Never observable as a **Port** — edges cannot target an internal-event name.

## Hardware Callback

Board-reader-driven event delivered to a **HardwareComponent** in response to Firmata wire activity. Two live kinds today, routed by `runtime/mod.rs::process_event` to typed methods on `HardwareComponent`:

- `_pin_change` (from the **Board IO Loop**'s `PinChangeCallback`) → `on_pin_change(value)`. `value` is `Bool` for digital pins, `Number(u16)` for analog.
- `_i2c_reply` (from `I2cReplyCallback`) → `on_i2c_reply(value)`. `value` is `Array` of byte values.

Emission of these reserved handles is the runtime's responsibility (in `FlowRuntime::install_pin_change_callback` / `install_i2c_reply_callback`); no flow edge may emit them. The two handle names plus the `_` prefix are centralized as consts in `runtime/mod.rs`'s `reserved_handles` module — referenced at each emit and `dispatch_internal_event` match site rather than written as bare string literals. A third reserved name `"stepper_reply"` is referenced in `Stepper::call_method` and the module docstring but has no current emission path — a forward-looking placeholder pending stepper sysex wiring, intentionally left out of `reserved_handles` until it routes anywhere.

## Host input

A key or a MIDI message a [Runtime Host](#runtime-host) read off a device and hands to core, which picks the nodes that hear it. Lives in `crates/microflow-core/src/runtime/host_input.rs` ([ADR-0037](docs/adr/0037-core-owns-host-input-fan-out.md)). Two entry points take the raw input and no node id: `FlowRuntime::dispatch_key_event(accelerator, pressed)` and `FlowRuntime::dispatch_midi_message(port_name, bytes)`. The listeners come from each node's Listener Wiring (see [Wiring](#wiring)) and hear the input one at a time, in node-id order, each one's cascade settling before the next: one turn, one [`Effects`](#effects), and on the desktop one IPC batch, however many nodes listen. Each cascade has the whole [Turn budget](#turn-budget).

The host owns the device and asks core what the flow wants: `listens_to_midi()` (is there any MIDI interest — a browser asks for Web MIDI access only then), `wants_midi_input(port_name)` (should this port be open), and `midi_device_matches(port_name, filter)`, the one device-name rule (a case-insensitive substring; the empty filter passes every port), which a host also applies to its output ports for a `MidiSend`. The desktop's `MidiManager` (`apps/web/src-tauri/src/runtime/midi.rs`) and the browser's `MidiPerformer` (`apps/web/src/runtime/midi/midi-performer.ts`) only move bytes; keys arrive through `useHotkeyEvents` (`apps/web/src/runtime/use-hotkey-events.ts`).

Distinct from a **Hardware Callback**, which the runtime decodes from the board's own bytes, and from a **Port**, which an edge delivers. A MIDI node's channel and mode filtering is the node's, not the fan-out's.

## FlowRouter

The seam that turns one outgoing `ComponentEvent` into the list of `DispatchCall`s the executor invokes. Lives in `crates/microflow-core/src/runtime/router.rs`. Owns the (source, source_handle) → target index (`EdgeMap` backed by `FxHasher` over both strings with a 0-byte separator) and the per-target delivery decision; nothing else in `FlowExecutor` knows the edge layout.

Two delivery shapes today, chosen per target via `ComponentLookup::aggregates(target_id)`:

- **Direct** — pass `event.value` (cloned once) through to one target. The default for non-aggregating targets.
- **Snapshot** — collect every source feeding the same `(target_id, target_handle)` via `ComponentLookup::value_of(source)` and wrap as `ComponentValue::Array`. Chosen for targets that return `Component::aggregates_inputs() == true` (today `Calculate`, `Gate`). The just-emitted source must already have been `set_value`'d by the executor's echo step, or snapshot reads a stale value for it — see `runtime/mod.rs::process_event`.

`ComponentLookup` is a 2-method trait (`aggregates`, `value_of`) the executor satisfies with a thin `ComponentMapLookup` adapter over its `HashMap<String, Box<dyn Component>>`. The router has no opinion about how components are stored; router tests pass a `HashMap<String, (bool, ComponentValue)>` mock and never instantiate real Components.

Internal Events and Hardware Callbacks never reach `FlowRouter` — source == target by construction, dispatched straight from `executor::process_event`. Stale-sequence gating also happens upstream of `route()`. Decision and migration captured in `docs/adr/0002-flow-router-seam.md`.

## Sans-IO Runtime

The Live Flow Runtime is **sans-IO**: a node never touches the serial port, a clock, or a timer. The engine lives in `crates/microflow-core/src/runtime/` (gated behind the `runtime` cargo feature) and is driven by a **Runtime Host** per platform. Decision and migration captured in [ADR-0006](docs/adr/0006-rehost-runtime-on-core.md). During one `dispatch` / `on_pin_change` / `wake`, a **Component** is handed a [`RuntimeContext`](#runtimecontext); when the turn drains, the runtime returns one [`Effects`](#effects) record the host applies. The `BoardHandle`, **Board IO Loop** and `CommandReceipt` that ADR-0001 and ADR-0002 describe are not in the code.

## RuntimeContext

The per-dispatch capability context. Lives in `crates/microflow-core/src/runtime/context.rs`. Exposes exactly three host capabilities to a node for the duration of one call: a [`BoardWriter`](#boardwriter) (`ctx.board()` — encodes Firmata bytes into the turn's outbound buffer), the host clock (`ctx.now_ms()`), and the wakeup scheduler (`ctx.schedule_wakeup(method, delay_ms)` / `ctx.cancel_wakeup(method)`). The node id is implicit, so scheduling targets the caller. A node cannot block, sleep, or read a wire — those are the host's job, recorded as [`Effects`](#effects).

## Effects

The side-effect record the host executes after one runtime turn. Lives in `crates/microflow-core/src/runtime/context.rs`. `Effects { outbound_bytes: Vec<u8>, component_events: Vec<ComponentEvent>, wakeups: Vec<Wakeup>, cancellations: Vec<WakeupId>, cloud_requests: Vec<CloudRequest>, node_diagnostics: Vec<NodeDiagnostic> }`. Its TypeScript shape is generated by ts-rs into `apps/web/src/lib/bindings/Effects.ts`, not hand-written — see [WASM_BOUNDARY.md](docs/WASM_BOUNDARY.md). Every `FlowRuntime` entry point (`update_flow`, `feed_bytes`, `wake`, `dispatch`, `deliver_message`, `inject_event`, and the two [Host input](#host-input) entry points `dispatch_key_event` and `dispatch_midi_message`) returns one `Effects`. The **Runtime Host** writes `outbound_bytes` to the port, dispatches `component_events` to its UI stores, arms each [`Wakeup`](#wakeup) as a timer, clears `cancellations`, performs `cloud_requests`, and reports `node_diagnostics`. Nothing crosses the wire until the host applies the effects — which is what makes the runtime testable without hardware or a host (feed input, assert on the returned `Effects`). *How* a host applies the fields — their order — is not the host's choice: it is fixed by [`Effects::apply`](#effectssink) ([ADR-0008](docs/adr/0008-effects-apply-policy.md)). In the browser the call producing an `Effects` goes through the [RuntimeBridge](#runtimebridge), so a faulted turn yields no effects at all rather than a half-applied one ([ADR-0017](docs/adr/0017-wasm-fault-seam.md)).

## EffectsSink

The typed per-field hook surface a [Runtime Host](#runtime-host) implements to apply one turn's [`Effects`](#effects); the **apply policy** that drives it lives in core, once. `Effects::apply(&self, sink: &mut impl EffectsSink)` (`crates/microflow-core/src/runtime/context.rs`) iterates the fields in the **canonical order** — `outbound_bytes → cancellations → wakeups → cloud_requests → component_events → node_diagnostics` — calling one hook each: `write_bytes`, `cancel_wakeup`, `arm_wakeup`, `perform_cloud`, `dispatch_events` (the turn's events in one call; its default loops `dispatch_event`), `report_diagnostic`. Bytes first (wire latency); cancel-before-arm (a cancellation never names a timer of the same turn, see [Wakeup](#wakeup)); cloud calls launched before UI events leave; UI events after that (they leave the runtime and do not feed back this turn). Decided in [ADR-0008](docs/adr/0008-effects-apply-policy.md). The platform *primitives* behind each hook stay per-host (desktop: serial flush + Tauri `emit` + Tokio timer; browser: `connection.write` + store ingest + `setTimeout`). The desktop `Actor` calls `Effects::apply` directly; the browser reactor cannot reach into Rust, so it mirrors the same shape in `apps/web/src/runtime/effects-sink.ts` (`applyEffects` + an `EffectsSink` interface `FlowReactor` implements). The mirror is held **structurally**: `applyEffects` drives an `EFFECT_HANDLERS` map and an `APPLY_ORDER` tuple, both typed exhaustive over `keyof Effects`, so an `Effects` field without a handler or a place in the order is a TypeScript compile error on the browser side, just as it is a missing trait method on every Rust sink. The conformance tests (`context::apply_tests`, `apps/web/src/runtime/effects-sink.test.ts`) assert the runtime *order*. Adding an `Effects` field thus forces a hook in core's trait **and** in the browser handlers.

## BoardWriter

The sans-IO Firmata write surface used by hardware **Component**s. A trait in `crates/microflow-core/src/runtime/board.rs` with typed methods (`set_pin_mode`, `digital_write`, `analog_write`, `enable_analog_reporting`, `shift_out`, `tone`, `sysex`, the I2C ops, …), each encoding one or a few Firmata messages — none block or do I/O. The production adapter `BufferBoardWriter` encodes into the turn's outbound `Vec<u8>` via the shared `FirmataClient` codec; it is built fresh per turn, borrowing the runtime's codec (for the pin table) and the buffer. Tests assert on `Effects.outbound_bytes` directly, or on the board state a [Sim board](#sim-board) reads from those bytes.

## Sim board

The second adapter at the board byte seam: `SimBoard` in `crates/microflow-core/src/firmata/sim/`, a scripted device that consumes the bytes a runtime writes and answers with the bytes StandardFirmata would. Tests read board state ("pin 9 is PWM at 128"), drive inputs, and inject faults (a reset with re-announce, dropped bytes, a cut sysex, an I2C NACK). Compiled only under `cfg(test)` or the `sim-board` feature, never into a release or wasm build ([ADR-0030](docs/adr/0030-hardware-tested-at-the-byte-seam.md)). Its counterpart for flashing is the [Modelled bootloader](#modelled-bootloader).

- **Sim rig** — `SimRig` (`firmata/sim/rig.rs`): an in-process [Runtime Host](#runtime-host) that joins a sim board to a `FlowRuntime` on a virtual clock. It handshakes with its own codec, seeds the runtime like the real hosts, and applies `Effects` through `Effects::apply`.
- **Board layout** — the pin table, capabilities and analog mapping a sim board answers with: `BoardLayout::uno()`, `mega2560()`, `leonardo()`.
- **Firmware violation** — a write StandardFirmata accepts but silently ignores (an analog write to a pin not in PWM or servo mode, a mode the pin lacks). The sim board records it, so a test can fail on it.

## Modelled bootloader

The firmware end of a flash, for tests: `SimBootloader` in `crates/microflow-core/src/flasher/sim.rs`. It consumes the bytes a flasher writes, answers as the real bootloader would, and keeps the chip's flash, so a test asserts on what was programmed and not on the bytes sent. Four models, each transcribed from the bootloader in the Arduino AVR core: Optiboot (Uno, newer Nano), ATmegaBOOT (older Nano, Duemilanove), stk500boot (Mega 2560), Caterina (Leonardo, Micro). Each runs its own deadlines on a virtual clock and records what a real bootloader would choke on or drop as a **violation**. The bootloader counterpart of the [Sim board](#sim-board): compiled only under `cfg(test)` or the `sim-board` feature. `SimSerial` (`apps/web/src-tauri/src/flasher/sim_serial.rs`) puts one behind the desktop executor's `SerialHost` seam. A model can be wrong; a real board has the last word (the flash check of the [Hardware smoke suite](#hardware-smoke-suite)).

## Wakeup

A future self-callback a timer node asked for, in place of a sleep. Lives in `crates/microflow-core/src/runtime/context.rs`. `Wakeup { id: WakeupId, node_id, method, delay_ms }`. A node has **one wakeup per method**: `ctx.schedule_wakeup(method, delay_ms)` replaces the pending one, `ctx.cancel_wakeup(method)` drops it. A turn's timer requests are resolved in the order the nodes made them (`FlowRuntime::resolve_schedule`, `runtime/mod.rs`) against the runtime's outstanding-wakeup table. A timer asked for and then cancelled or re-scheduled in the same turn is **withdrawn**: it never reaches the host. So `Effects.wakeups` holds only timers to arm, and `Effects.cancellations: Vec<WakeupId>` only timers an earlier turn handed over ([ADR-0008](docs/adr/0008-effects-apply-policy.md), amendment). The **Runtime Host** owns the actual timer and calls `FlowRuntime::wake(node_id, method)` when it fires, which routes `dispatch_internal(method, …)` back to the node. Used by `Interval`, `Delay`, `Piezo` song playback, and other timer nodes.

## Queue (Delay)

A Delay with `forgetPrevious` off, the default: every trigger fires `delay` ms after it arrived, in arrival order, on `event`, carrying the value it arrived with. It holds up to `QUEUE_CAPACITY` (16) pending triggers (`DelayConfig::capacity()`, `crates/microflow-core/src/nodes/delay/config.rs`), live and in the generated sketch alike; a trigger that arrives while 16 wait takes the place of the newest pending one, so the ones about to fire keep their time. Live, a dropped trigger raises one warning on the node, which comes down when the queue has drained or the Delay is built again; the sketch does not warn and fires at most one trigger per `loop()`. Decided in [ADR-0043](docs/adr/0043-timed-nodes-share-one-bound-live-and-on-the-board.md).

## Debounce (Delay)

A Delay with `forgetPrevious` on: it holds one trigger, a new trigger takes the place of the pending one, and only the latest fires, `delay` ms after it arrived. The one-slot case of the [Queue](#queue-delay)'s rule; it never warns. [ADR-0043](docs/adr/0043-timed-nodes-share-one-bound-live-and-on-the-board.md).

## Trigger window

The values a Trigger holds from its last `within` ms, each with the time it arrived on the engine clock (`RuntimeContext::now_ms`): at most `WINDOW_CAPACITY` (16), live and in the generated sketch alike, and a value that arrives while the window is full takes the place of the newest held one. A new value is compared with the oldest value held, which is what a change counts from; the Trigger bangs once per crossing. [ADR-0043](docs/adr/0043-timed-nodes-share-one-bound-live-and-on-the-board.md).

## Runtime Host

The platform adapter that drives a `core::FlowRuntime` and applies its [`Effects`](#effects). Two real adapters make the `Effects` a real seam ([ADR-0006](docs/adr/0006-rehost-runtime-on-core.md)):

- **Desktop** — `apps/web/src-tauri/src/runtime/host.rs`. A `!Send` `FlowRuntime` lives inside a dedicated actor thread (`run_actor`) that owns the [Board Session](#board-session) and a Tokio handle (timers, cloud I/O). Only `Send` handles cross the spawn boundary. Its cloud half is the [CloudPerformer](#cloudperformer); what comes back re-enters as actor messages: an LLM result as `ActorMsg::Inject` (→ `inject_event`), an inbound broker message as `ActorMsg::Deliver` (→ `deliver_message`), and a key or a MIDI message as `ActorMsg::Key` / `ActorMsg::MidiMessage` ([Host input](#host-input)). Every turn runs under the [Runtime Supervisor](#runtime-supervisor). Its webview half is the [Desktop Runtime Host](#desktop-runtime-host).
- **Browser** — `apps/web/src/runtime/flow-reactor.ts`. A `setTimeout` / Web-Serial loop driving the `microflow-runtime-wasm` engine: writes `outbound_bytes` to the port, fans `component_events` to the Zustand stores, maps `wakeups` to `setTimeout` and `cancellations` to `clearTimeout`. The serial/timer/effects-apply half is a shallow pass-through (depth lives behind the wasm seam in Rust); the **cloud** half is its own [Browser CloudPerformer](#browser-cloudperformer), and every call into the engine goes through the [RuntimeBridge](#runtimebridge).

## Desktop Runtime Host

The webview half of the desktop [Runtime Host](#runtime-host), alive for the whole app: `DesktopRuntimeHost` (`apps/web/src/runtime/desktop-runtime-host.ts`), started once at the root and never torn down by navigation. It applies the actor's component events and node diagnostics, plays audio, performs LLM generations through the shared `LlmPerformer` ([ADR-0021](docs/adr/0021-one-llm-transport-in-the-webview.md)), and surfaces runtime crashes. The flow route only attaches its document (edges for wire animation, a Music node's files).

## Runtime Supervisor

The desktop actor's answer to a panicking turn (`apps/web/src-tauri/src/runtime/supervisor.rs`, the policy half; `Actor::recover` in `host.rs`, the actor half). Every turn runs under `catch_unwind`. A panic emits `runtime-crashed` with a non-PII fingerprint (the turn's op and code location, never the message), discards the runtime, writes the [Safe state](#safe-state) and [Respawns](#respawn). The `CrashGuard` halts instead after 3 panics within 60 s, until the user restarts (`runtime_restart`). Desktop only; the browser's answer to a trap is reload ([ADR-0017](docs/adr/0017-wasm-fault-seam.md)).

## Respawn

Building a fresh desktop runtime after a panic: seeded from the live [Board Session](#board-session)'s pin table, the last flow re-applied, then the MQTT subscriptions (`CloudPerformer::reconcile`) and the open MIDI inputs (`MidiManager::reconcile`) reconciled against the respawned runtime. The state a replug would reach, without the replug. It does not restore outputs: a panicked runtime's last values are not trusted.

## Turn budget

The most events one cascade may drain: `TURN_BUDGET` (10 000) in `crates/microflow-core/src/runtime/turn_budget.rs`. A turn is one stimulus and the cascade it causes, so for every stimulus but one the budget bounds the turn. The exception is a [Host input](#host-input) with several listeners: that is one turn made of one cascade per listener, and each cascade has the whole budget, so a listener whose cascade runs away does not cost the others the input. A cascade that reaches the budget is stopped and the rest of its queue dropped, so a runaway flow cannot hang a host. If the last emitters sit on a cycle, that cycle's nodes become [Paused nodes](#paused-node). Without a cycle (an acyclic fan-out), nothing is paused and the node where the budget ran out gets a warning that the next flow update clears.

## Paused node

A node on a loop that spent the [Turn budget](#turn-budget): the whole strongly connected component of the flow's edges, not only the nodes the last events touched. It still runs, but its emits are not routed. Released by a flow update that reshapes the loop: a paused node removed or rebuilt, or an edge touching one added, removed or re-pointed. Shown through [Node health](#node-health).

## Node health

The runtime's own ledger of what is wrong with each node (`NodeHealth`, `crates/microflow-core/src/runtime/health.rs`): it could not be built (a type the runtime does not know, or an [Unreadable config](#unreadable-config)), its `initialize`/`on_start` failed (including a missing firmware feature such as LED-strip or AccelStepper support), it is a [Paused node](#paused-node), the board cannot serve its pin (the live pin check, `runtime/pin_check.rs`), a turn overloaded at it, its output is held in a [Reset storm](#reset-storm), or an input was rejected. It raises and clears only on a change and projects the most severe fault onto the node's badge through `Effects.node_diagnostics`. Every **node diagnostic** carries an origin: `runtime` for this ledger, `node` for what a node reports about itself (an I2C NACK, Music's "no songs"). An origin clears only its own; the badge shows the most severe of the two.

## Detection codec

The `FirmataSession` instance the probe drives, owned by the browser [Board Link](#board-link) (`apps/web/src/board/board-link.ts`, [ADR-0018](docs/adr/0018-two-firmata-decoders.md)). It answers the **handshake** questions — what firmware is this, what pins does it have — which is what `probeBoard` polls via `firmwareName()` and `pinsJson()`, and it is the only decoder alive during the probe, before any [Runtime Host](#runtime-host) exists. It supplies the runtime's [pin seed](#pin-seed) and keeps `connectedState` truthful. Like every `FirmataClient`, it never panics on any byte stream: a malformed or truncated frame is dropped (`firmata::sim::noise` fuzzes this).

In steady state the browser feeds each inbound chunk to **both** the detection codec and the runtime (through the [Inbound queue](#inbound-queue) until the runtime attaches), unfiltered and in the same order. That is not duplication to be eliminated: both wrap the same `microflow_core::firmata::FirmataClient`, so they are one codec answering two questions at two lifetimes, and consistency follows from the identical stream rather than from any synchronisation between them. The detection codec's per-chunk report is not decoded on the JS side — nothing consumes it once a flow is running.

## Pin seed

The one-shot `setPins` when a `FlowReactor` is created, from `link.pinSeed` — the [detection codec](#detection-codec)'s [Pin Profile](#pin-profile) as `PinInfo[]`, snapshotted the instant the handshake completed ([ADR-0018](docs/adr/0018-two-firmata-decoders.md)). It hands the runtime the capability response it was not alive to decode. One shot suffices: boards do not send capability responses unsolicited, a re-enumeration re-probes and seeds again, and a board that reboots under an open port is a [Re-announce](#re-announce) the runtime handles from its own decode. The desktop seeds from the probe's `pins_json`, the same `PinInfo[]`.

## RuntimeBridge

The browser's one crossing into the wasm flow runtime, and the only holder of a `FlowRuntime` handle. Lives in `apps/web/src/runtime/runtime-bridge.ts` ([ADR-0017](docs/adr/0017-wasm-fault-seam.md)). The surface is one **typed entry point** per runtime op the host uses — `setPins`; the turns `updateFlow`, `feedBytes`, `wake`, `dispatch`, `injectEvent`, `deliverMessage` and the two [Host input](#host-input) ops `keyEvent` and `midiMessage`; and the questions `reconcileSubscriptions`, `listensToMidi`, `wantsMidiInput` and `midiDeviceMatches` — each owning its op's whole call codec: the JSON encode of arguments and the decode of replies into the ts-rs binding types ([`Effects`](#effects), `DesiredSub[]`) or a boolean, so no caller touches a JSON string or casts a result. `call(op, node, fn)` is the **private** core they all route through: every wasm entry point returns `Result<String, JsError>` — a *throw* on the JS side — so `call` wraps each one, returns the reply or `undefined`, and **never throws**. Faults are classified into three kinds and routed to a surface that already exists: `badInput` (Rust returned `Err` — or the host could not decode the reply; the module is intact and only this turn is lost) → the node's diagnostic badge when the op names a node (`wake`, `dispatch`, `injectEvent`, `deliverMessage`; a host-input op names none, so its fault goes to the console); `engineBroken` (a wasm trap) → the board error state, reactor disposed, and the link closed after writing the [Safe state](#safe-state), until reload; `disposed` → the console, once.

A trap does not destroy the wasm instance — the module stays mechanically callable — but it destroys the runtime's *invariants*, since the panic aborted mid-mutation and no destructor ran. So the bridge latches closed **by policy** on `engineBroken`, before the fault is routed, and a deterministic fault faults once rather than per chunk. This is what keeps an engine fault out of the transport layer: the Web Serial read loop cannot mistake a decode defect for an unplugged board (`onClosed` means the reader ended, and nothing else), and a timer callback — which has no caller to catch it — cannot become an uncaught exception. The runtime surface is declared *structurally* (`FlowRuntimeCalls`), so the bridge needs no value import of the wasm glue and its tests drive a double with no wasm, no port, and no React.

## CloudPerformer

The cloud half of the desktop [Runtime Host](#runtime-host), and the one owner of the flow's MQTT subscriptions there: `CloudPerformer` in `apps/web/src-tauri/src/runtime/cloud_performer.rs` ([ADR-0035](docs/adr/0035-desktop-cloud-performer-owns-subscriptions.md)). Two entry points. `perform(request)` publishes the `MqttPublish` [`CloudRequest`](#cloudrequest)s a turn recorded. `reconcile(wirings)` makes the brokers' subscriptions match the runtime's subscriber [Wiring](#wiring) and runs the [Figma Announce Policy](#figma-announce-policy); it returns a `Reconciled` to wait on, which is how `flow_update` resolves with the flow's topics subscribed.

`reconcile` only queues. One task holds the live set and applies reconciles one at a time, in the order the runtime actor made the calls (after a flow update, after a [Respawn](#respawn)). The live set mirrors the brokers: an entry is recorded when the SUBSCRIBE went out and dropped when the UNSUBSCRIBE went out or its [Broker session](#broker-session) ended, so whatever could not be done is still a difference from the desired set. The task keeps the last wirings and reconciles them again whenever the pool's `changes()` ticks; nothing has to send the flow again. It reaches the pool only through [MQTT Brokers](#mqtt-brokers). Its browser twin is the [Browser CloudPerformer](#browser-cloudperformer). Not the performer of LLM, MIDI or audio requests: the actor takes those first.

## Broker session

One broker's connection in the desktop pool, as `MqttManager::session` reports it: `BrokerSession { id, online, link }` (`apps/web/src-tauri/src/mqtt/manager.rs`). It starts when the broker is first connected and ends when it is disconnected or connected with a different URL or credentials. It outlives a dropped link: the client reconnects by itself and re-subscribes what it holds, and a `connect` with the same config repairs it sooner, under the same id. `link` is a new number each time the session's link comes up, and the same for as long as that link lasts; every new link is told again that Studio is there and asked for the variables, because a broker may have lost what an earlier link told it. The flow's subscriptions belong to the session and end with it, which is why the [CloudPerformer](#cloudperformer) keys its live set on the session id. The [Connection Console](#connection-console)'s subscriptions belong to the broker id instead: the pool makes them again on every session for it, until the console unsubscribes (at once, whatever the link does), the broker is removed, or the page that made them reloads.

- **Last words** — what the session publishes just before the pool ends it on purpose (disconnected, removed, given other settings, the app quitting), if its link is up: the `disconnected` of every Bridge ID announced on it and every one it is owed, left with the pool by the CloudPerformer (`MqttBrokers::set_last_words`). Said within `LAST_WORDS_TIMEOUT` (2 s) with the pool unlocked. On quit every session ends at once within `QUIT_GRACE` (2.5 s).
- **Will** — the first last word, which every link of the session leaves with the broker as its MQTT will, published by the broker when the link ends without a goodbye. A link carries one will, fixed when it opens: when the will changes, the client opens a new link with a new client id that carries it, moves the subscriptions there, and then says DISCONNECT on the old one (make before break); the renewed link keeps its `link` number. So a crash takes back one Bridge ID per broker. The browser's connections carry the same will ([Browser CloudPerformer](#browser-cloudperformer), [ADR-0049](docs/adr/0049-a-broker-session-leaves-its-goodbye-with-the-pool.md)).
- **Settings and generations** — the pool keeps the settings it was last given per broker id, with a generation; an attempt goes into the pool only while its generation is still the broker's. `MqttManager::sync` takes the whole broker list, numbered at the call; a list that is no longer the newest is not applied.

One connection attempt is bounded by `CONNECT_TIMEOUT` (30 s) and holds no lock; every write to a link by `WRITE_TIMEOUT` (10 s), after which the link counts as dropped. Flow updates are applied in the order they arrive (`FlowUpdates`, `runtime/commands.rs`): one that is still waiting for its brokers when a newer one arrives is replaced, never applied, and answers as the newer one does. A flow update waits for brokers that are not up for `BROKER_GRACE` (2 s, all of them together), once per stretch of a broker being down (`MqttManager::stretch`), and then applies the flow without them. The browser has no pool; its counterpart is a connection in `BrokerConnections`.

## Status snapshot

Every desktop broker's status at one moment, numbered: `BrokerStatuses { seq, brokers }` (`apps/web/src-tauri/src/mqtt/commands.rs`, from `MqttManager::status_snapshot`). The pool ticks whenever a status may have changed, and `report_broker_statuses` sends the `mqtt-broker-status` event when the list differs from the last one sent; `mqtt_sync_brokers` answers with one too. The two can arrive in either order, so the webview keeps the snapshot with the higher `seq` (`cloud/cloud-capabilities.ts`). The browser's dots come from its status probe instead.

## Browser CloudPerformer

The cloud half of the browser [Runtime Host](#runtime-host): `CloudPerformer` in `apps/web/src/cloud/cloud-performer.ts`, the twin of the desktop [CloudPerformer](#cloudperformer) ([ADR-0009](docs/adr/0009-cloud-sans-io-capability.md)). `perform(request)` does a turn's cloud `Effects`: `llmGenerate` through the shared `LlmPerformer`, `mqttPublish` over MQTT-over-WebSocket. `reconcile(desired)` takes the already-reconciled set from the wasm `reconcileSubscriptions()` binding and brings the brokers in line, including the [Figma Announce Policy](#figma-announce-policy).

It owns the subscription state ([ADR-0036](docs/adr/0036-browser-host-owns-subscription-state.md)):

- **wanted / live** — `wanted` is the last reconciled set; `live` is what the brokers hold. A subscription is live once the broker's SUBACK accepted it. Whatever is wanted and not live (no broker configured, a URL that cannot be opened, a link that is down, a refused topic) is asked for again at the next `reconcile` and on every connect.
- **`BrokerConnections`** (`cloud/mqtt-client.ts`) — one connection per broker id and the topics asked of it. It subscribes every topic again on each connect; `mqtt.js` is a transport only (`clean: true`, `resubscribe: false`). Behind an injectable `MqttClientFactory`: production wraps `mqtt.connect`, tests pass a fake client, and `mqtt-client.real.test.ts` drives the real client against a scripted broker.
- **Following the settings** — the performer reads and watches [Settled broker settings](#settled-broker-settings) (`CloudDeps.resolveBroker`, `CloudDeps.watchBrokers`, supplied from `cloud/mqtt-broker.ts`), so a broker's connection follows an edit at once, once it has settled.
- **In use** — a broker has a connection while the flow wants a topic on it, and for `BROKER_IDLE_MS` (60 s) after something was published on it. A flow's publish goes out on a link that is up and is dropped on one that is down; the publishes that open a connection wait for its first connect (`OPENING_PUBLISH_MS`, 5 s at most). A status publish of the handshake is stored by `mqtt.js` while the link is down. A publish to a topic with a wildcard, or an empty one, is dropped with one warning.
- **Routing** — an inbound message goes to every topic filter of the connection it matches, once per subscription, with a retained replay only to a subscription that has not had that topic since it joined. The same rule as the desktop, by one filter table ([ADR-0048](docs/adr/0048-routing-overlapping-subscriptions.md)).
- **Goodbye** — what each broker's goodbye says is asked of the [Figma Announce Policy](#figma-announce-policy) when a Bridge ID is announced (`farewells`), so saying it needs no engine. A connection that is replaced, closed or disposed while its link is up first says `disconnected` for every Bridge ID announced on it, after an engine fault too. The page going away (`pagehide`) says every goodbye, best effort, and keeps the will; a page back from the back/forward cache (`pageshow`) announces again.
- **Will and links** — the first goodbye of a broker (in uid order) is the will of that connection's links (`BrokerConnections.setWill`), as on the desktop's [Broker session](#broker-session). A will change renews the link make before break: a new client id with the new will takes over the subscriptions, keeping what each has seen, and the old link says DISCONNECT; a renewal not connected within `RENEW_MS` (5 s) is closed. `BrokerConnections.link()` numbers a connection's links; every new link, `mqtt.js`'s own reconnects included, is told again that Studio is there, and a renewed link keeps its number.

It is **host-free**: it never touches the wasm runtime, the board connection or a Zustand store. The two re-entry points into the runtime (an LLM result, an inbound broker message) and the announce policy arrive as injected callbacks (`ResultInjector`, `InboundDeliver`, `FigmaAnnounce`), and the broker and provider lookups as `CloudDeps`. `FlowReactor` keeps the serial loop and the [`EffectsSink`](#effectssink) apply. Not the [Connection Console](#connection-console)'s connection: that is separate, so testing a broker by hand never touches the flow's subscriptions.

## Settled broker settings

The broker settings every connection is made from: `brokers` in the broker store (`apps/web/src/cloud/mqtt-broker.ts`, [ADR-0046](docs/adr/0046-connection-settings-settle-in-their-store.md)). What is typed into the settings form is kept apart, per broker, in `unsettled`, and joins `brokers` `BROKER_SETTINGS_SETTLE_MS` (500 ms) after the last keystroke for that broker. Adding, removing and choosing another default broker are not typing and settle at once. `settleBrokerSettings` settles what is typed without waiting; a flow update, a console command, the form closing and the page being hidden while the form is open call it. Every reader reads `brokers`: the desktop host's broker sync, the broker list of a flow update, the [Browser CloudPerformer](#browser-cloudperformer), the browser status probe and the [Connection Console](#connection-console)'s link. Only the form reads what is typed (`useBrokerSettingsForm`), and shows a broker whose URL, username or password is typed and not settled as `connecting`. Storage holds the settings as typed, so a reload brings back what was on screen, settled. The [LLM Provider](#llm-provider) settings settle the same way.

## Wiring

Per-impl description of how a constructed **Component** attaches to its execution environment. Returned as plain data from the `Component` trait; the runtime and its host read and apply it without naming any specific component. Types in `crates/microflow-core/src/runtime/wiring.rs`.

Wiring is **descriptive, not active**: components return data, the runtime acts. A component's wiring is tested as a value, with no `&mut self` and no sinks.

Three kinds:

- **Listener Wiring** — sync, in-process. Board input the runtime decodes itself: a pin (digital, or analog with threshold), an I2C address and register. And [Host input](#host-input): a hotkey accelerator (`ListenerWiring::HotKey`), a MIDI input device filter (`ListenerWiring::MidiInput`). Returned from `Component::listener_wiring()` as `Vec<ListenerWiring>`.
- **Board Wiring** — board-wide reconcile votes (sampling interval, I2C read-delay, one continuous read). Returned from `Component::board_wiring()` as a `BoardWiring`; consumed by the **Board Reconcile Planner**.
- **Subscriber Wiring** — async, broker-dependent: a broker id, a topic and how a message is delivered (`Plain`, `TopicAware`, `DisplayEcho`). Returned from `Component::subscriber_wiring()` as `Vec<SubscriberWiring>`, empty for every node but `Mqtt` and `Figma`. `FlowRuntime::collect_subscriber_wirings()` gathers them; `reconcile_desired` collapses them to one desired subscription per `(broker, topic)` and each host's CloudPerformer makes the brokers match.

Distinct from the **Component Catalog**: catalog is metadata for _registration_ (what UI shows, how to construct); Wiring is per-impl _behavior_ applied after construction.

## Board Reconcile Planner

The outbound-setup twin of the **FlowRouter**: where the router plans one inbound event's fanout, the planner plans one `update_flow`'s board setup. Lives in `crates/microflow-core/src/runtime/reconcile.rs`. `plan_board(prev_report, prev_i2c_counts, desired: &DesiredBoard) -> BoardPlan` is a **pure function** — it takes the previous board state and the gathered **Board Wiring** (a `DesiredBoard`), and returns the ordered board operations to emit as a value. Every protocol quirk of board setup lives here: the analog-per-channel / digital-per-8-pin-PORT reporting diff, the MAX-vote reconcile of the single global sampling interval + I2C read-delay, and the `StandardFirmata` stop-count drain (each address is stopped *exactly* its prior query count, because `I2C_STOP_READING` clears the lone remaining query regardless of address — an extra stop would drop a sibling).

`BoardPlan` is split into two phases `update_flow` applies around per-node `HardwareComponent::initialize`, so a device's power-on writes land between them: **setup** (reporting reconcile, I2C bus config, sampling interval) before init, **arm** (drain existing continuous reads, then start the desired set) after. The planner is tested as a value — feed prev-state + desired, assert the `BoardPlan` — with no board and no runtime (`reconcile::tests`). `update_flow` keeps only: gather listener/board wiring → `plan_board` → encode the plan.

## Sketch Wiring

The static twin of the **FlowRouter** inside Sketch Generation (`crates/microflow-core/src/codegen/wire.rs`, [ADR-0013](docs/adr/0013-handle-aware-sketch-wiring.md)). Every edge is resolved by its real handles: `output_expression(node, source_handle)` (in `codegen/mod.rs`) maps each **Emit** to a typed C++ expression, and a **`NodeInputs`** groups the resolved sources per **Port** (`target_handle`) for the target's emitter. Emitters bind their actual ports — `emit(node, &NodeInputs) -> Result<NodeEmission, UnreadableConfig>` — instead of receiving one anonymous driver expression, and read their settings through [Node config resolution](#node-config-resolution).

Three shapes matter:

- **`CppExpr`** — a typed expression (`Bool | Double | Str | Opaque`). Consumers coerce via `as_bool`/`as_double(_or)`/`as_u8_or`/`as_string`, transcriptions of `ComponentValue`'s conversions, so a `String` source into a numeric port compiles to the runtime's fallback rather than invalid C++. `Opaque` is an [Opaque value](#opaque-value).
- **`SourceExpr`** — one emit handle's exposure: the value it carries and when it fires. An **event** carries an explicit `fired` flag, true on exactly the loop iterations the live node emits, once per emission whatever it carries: Compare and Gate `true`/`false` (each check), Button and Switch `true`/`false`/`event` (each new level), Delay and Interval `event`, Trigger `bang`, a Constant's one emission at the start. A **level** has no fired flag: the live node emits it when its value changes (`set_value`), so a pulse-consuming port detects its changes. A boolean node's handles all carry its state: `true` fires when it emits and the state is true, `false` when it emits and the state is false, and carries `false`. `starting_at(initial)` gives the value the runtime twin holds before it first emits, where that is not the type's zero (a Servo starts centred), so a change detector does not fire on the first tick.
- **`bind_pulses`** — the shared edge/change-detector primitive pulse ports consume firings through (one action per source firing; a sustained level counts once).
- **Transform rule** — `NodeEmission::transform(prefix, sources, step)` (`codegen/emit.rs`): a transform (Compare, Gate, Calculate, Function, Smooth, RangeMap) runs its step only on the loop iterations one of its sources fires, as the live node computes once per value it is sent, and not before its first input. An aggregating transform runs once on an iteration any source fires, reading every source's current value ([ADR-0050](docs/adr/0050-on-device-emission-timing-follows-the-live-node.md)).

`loop()` fragments concatenate in **dataflow (topological) order** — producers run before consumers within a tick; cycles append in id order. Aggregating Nodes (Calculate, Gate) fold over *all* wired sources, mirroring snapshot delivery. Edges the sketch cannot honor (missing source, valueless source handle, unmodelled port, surplus sources on a single-source port) surface as `// note:` comments in the sketch; node ids whose sanitized C++ tokens collide are refused by validation before emission, and a Node with an [Unreadable config](#unreadable-config) refuses the Sketch: both are error-severity problems, and one of them means no sketch. The `codegen/parity.rs` guards pin every Calculate/Gate variant and Counter port to its emitted C++, and hold every declared Emit to an on-device value or a [Reasoned refusal](#reasoned-refusal). Output nodes carry their live value on the board (a Led's level, a Relay's open state, a Servo's position); a Monitor's output is its source's, resolved across the flow by `Outputs` (`codegen/mod.rs`). A Led's `value` and a Servo's `value` / `rotate` act when their source changes, not on every pass of `loop()`.

## Opaque value

A colour or a list on the board (an Rgb, a Matrix, a Pixel strip's output, a RangeMap's `value`): `CppType::Opaque` in `crates/microflow-core/src/codegen/wire.rs` ([ADR-0013](docs/adr/0013-handle-aware-sketch-wiring.md)). It has no number and no text in the sketch, so it is held as a version: a `uint8_t` its producer moves on, never to 0, each time the value changes, exactly when the runtime emits it. A consumer can count it and detect its changes; a payload renders it as nothing. Version 0 is the plain number 0 an output holds before it shows anything.

## Reasoned refusal

A declared Emit with no on-device value, named with the reason in `codegen::no_value_reason` (`crates/microflow-core/src/codegen/mod.rs`): Music's `value` and `track`, the Pn532's `value`, an Llm's `thinking` / `done` / `error`. An edge from one gets a `// note:` with that reason in the sketch. The guard `every_declared_emit_has_an_on_device_value_or_a_reasoned_refusal` (`codegen/parity.rs`) fails on a declared Emit that has neither, and on a listed Emit that has a value under every setting.

## Runtime Services

The desktop's per-capability service layer, `apps/web/src-tauri/src/runtime/services/`. It holds one [Capability Trait](#capability-trait): [MQTT Brokers](#mqtt-brokers), which the desktop [CloudPerformer](#cloudperformer) publishes and subscribes through. It sits in the desktop crate so that Tokio and the MQTT client stay out of `microflow-core`.

Nodes hold no service. Core's `ComponentBuilder` is `{ type Config; fn build(id, config) }` (`runtime/component.rs`), and the cloud nodes are sans-IO: they record [`CloudRequest`](#cloudrequest)s and subscriber [Wiring](#wiring), which the host performs ([ADR-0009](docs/adr/0009-cloud-sans-io-capability.md)). There is no `RuntimeServices` bundle and no `ComponentBuilder::Deps`; that part of [ADR-0025](docs/adr/0025-per-capability-service-traits.md) is not in the code. LLM I/O is not in this layer either: the webview performs it for both hosts ([ADR-0021](docs/adr/0021-one-llm-transport-in-the-webview.md), see [LLM Provider](#llm-provider)).

## CloudRequest

An outbound call a node asks the host to perform, recorded as the [`Effects`](#effects) field `cloud_requests`. Lives in `crates/microflow-core/src/runtime/context.rs`. `CloudRequest { source: Arc<str>, kind: CloudRequestKind }`. The kinds: `MqttPublish { broker_id, topic, payload, retain }`, `MidiSend { device_name, bytes }`, `AudioPlay { track, volume, loop }` and `AudioStop` are fire-and-forget; `LlmGenerate { provider_id, model, system, prompt }` has a result that re-enters. A node's `dispatch` calls `ctx.request_cloud(kind)` instead of touching a network or a device; the host's [`EffectsSink`](#effectssink) `perform_cloud` hook performs it, and a result re-enters via `FlowRuntime::inject_event` keyed on `source`. The node holds no Tokio and no client library, and is unit-tested by asserting the recorded request (`runtime::cloud::test_support::recorded_cloud_requests`). Decided in [ADR-0009](docs/adr/0009-cloud-sans-io-capability.md).

Who performs what:

- `MqttPublish` (the `Mqtt` node, and the design variable node's set-back) — the host's CloudPerformer: the desktop [CloudPerformer](#cloudperformer) through [MQTT Brokers](#mqtt-brokers), the [Browser CloudPerformer](#browser-cloudperformer) over MQTT-over-WebSocket.
- `LlmGenerate` — the webview, on both hosts, through the one LLM transport ([ADR-0021](docs/adr/0021-one-llm-transport-in-the-webview.md)). The desktop actor forwards it as an `llm-request` event; the browser performer calls the shared `LlmPerformer`.
- `MidiSend`, `AudioPlay`, `AudioStop` — host peripherals, taken before the CloudPerformer: the desktop actor sends MIDI on its own connections and forwards audio to the webview as `audio-request`; the browser reactor hands them to its `MidiPerformer` and `AudioPerformer`.

A subscription is not a request. A node says what it wants to hear as Subscriber [Wiring](#wiring); core's **`reconcile_desired`** (`crates/microflow-core/src/runtime/subscriptions.rs`) collapses the wirings to one desired subscription per `(broker, topic)` — routing kinds beat display-echo, ties break on the lower node id — and each host's CloudPerformer diffs that set against its own live subscriptions and owns its broker I/O ([ADR-0010](docs/adr/0010-subscription-diff-stays-per-host.md)). The desktop calls `reconcile_desired` directly; the browser through the wasm `reconcileSubscriptions()` binding. Both hosts therefore pick the same owner per topic. An inbound message re-enters through `FlowRuntime::deliver_message`.

## Design-Tool Bridge

The link between a design file and a flow, over MQTT. A **design tool** is Figma
or Penpot; each has a plugin (`apps/figma-plugin`, `apps/penpot-plugin`) that runs
only while the file is open in the editor, never in a prototype. On the flow side
it is the **design variable** node (persisted type `Figma`, with a `source` field
naming the tool). Plugins, runtime and codegen speak one protocol, defined in
`packages/design-bridge` (TypeScript) and `crates/microflow-core/src/design_bridge.rs`
(Rust) and checked against `packages/design-bridge/fixtures/protocol.json`
([ADR-0028](docs/adr/0028-design-tool-bridge-protocol.md)). What runs the
protocol inside a plugin is the [Plugin bridge session](#plugin-bridge-session).

- **Bridge variable** — one value a plugin exposes: a Figma variable in the `MHB`
  collection, or a Penpot token in the `MHB` token set. It has the tool's own
  stable `id`, a `name` and a `resolvedType` (`BOOLEAN`, `FLOAT`, `STRING`,
  `COLOR`); colors are `{r, g, b, a}` with channels 0–1. Penpot has no boolean
  tokens.
- **Wire ID** — a bridge variable's `id` made topic-safe (`VariableID:1:2` →
  `1-2`; Penpot uuids unchanged).
- **Bridge ID** — the `{uid}` topic segment that pairs Studio with the plugins.
  Studio shows it on the design variable node (derived from the account name, a
  random per-device ID when there is none, or the user's own); the plugin's
  "Bridge ID" field must hold the same value.
- **Tool segment** — the sender in `microflow/{uid}/{client}/…`: `figma`,
  `penpot`, or `app` for Studio.

## Plugin bridge session

Everything a design-tool plugin's UI iframe does between its sandbox and the
broker, as one framework-free module: `createPluginBridgeSession({ tool,
sandbox, storage, onInvalid?, broker? })` in
`packages/design-bridge/src/session.ts`
([ADR-0040](docs/adr/0040-plugin-bridge-session.md)). It owns the settings
(load, validate, store), the broker connection, the plugin's presence
(`{tool}/status`: `connected` retained on every connect, `disconnected` by
last will), one `DesignBridge` engine per connection and the snapshot polling
(`POLL_INTERVAL_MS`, 250 ms). Its state is `{ settings, settingsErrors,
connection, studio, entries }`; a plugin's views read it through
`useBridgeSession` (`packages/design-bridge/src/react.ts`) and call
`saveSettings`, which replaces the connection with no pause. Each plugin
builds one when its UI script loads (`apps/figma-plugin/src/ui/channel.ts`,
`apps/penpot-plugin/src/ui/channel.ts`) and it lives as long as the window.
Presence heals itself: a `disconnected` on the session's own status topic,
after the broker has sent its `connected` back, makes it announce `connected`
again. Not Studio's side of the bridge: Studio's presence is the
[Figma Announce Policy](#figma-announce-policy), performed by a Runtime Host.

- **Broker seam** — `BrokerConnector` (`broker.ts`), the session's way to a
  broker. Two adapters: `mqttBroker` (`mqtt-broker.ts`, mqtt.js over a
  WebSocket, resubscribing every filter itself on each connect) and
  `createMemoryBroker` (`memory-broker.ts`, tests: retained messages, last
  wills, per-level wildcards). The plugins' MQTT client is part of
  `@microflow/design-bridge`, exported on the `@microflow/design-bridge/session`
  subpath; the package root carries no mqtt.js.
- **Broker URL** — what a plugin user types, `[ws://|wss://]host[:port][/path]`,
  parsed by `parseBrokerUrl` (`broker-url.ts`): `wss` by default, port 8883
  (`wss`) or 1883 (`ws`), path `/mqtt`. Distinct from Studio's own broker URL
  handling in `apps/web/src/cloud/`.
- **Settings storage** — `SettingsStorage` (`load`, `save`), the one thing a
  plugin supplies besides its sandbox channel: Figma's client storage through
  the sandbox, Penpot's `localStorage`. The stored shape is
  `{ state: { mqttConfig: { url, uniqueId, … } } }` under `SETTINGS_KEY`.

## Sandbox adapter

A design tool's half of a plugin: the code with access to the design file,
behind two functions. `SandboxAdapter` (`packages/design-bridge/src/sandbox.ts`)
is `readSnapshot()` (the bridge variables with their current values; ones the
bridge cannot carry are left out) and `writeValue(id, value)` (returns `null`,
or a `WriteRejection` whose message the user sees). Two adapters:
`createFigmaAdapter` over the `MHB` variable collection
(`apps/figma-plugin/src/plugin/variables.ts`) and `createPenpotAdapter` over the
`MHB` token set (`apps/penpot-plugin/src/plugin/tokens.ts`).
`createSandboxBridge(adapter, host, glue)` is the routing every tool shares: the
UI's hello, snapshot requests and writes go to the adapter, and `glue` handles
what only that tool's host can do (storage, toasts, links, resizing). The
adapter knows nothing of MQTT; the [Plugin bridge session](#plugin-bridge-session)
is on the other side of the message channel.

## Figma Announce Policy

What Studio publishes to the design-tool plugins when a **Bridge ID** arrives on or leaves a broker: core's **`figma_announce_actions(prev, next)`** (`crates/microflow-core/src/runtime/subscriptions.rs`), shared by both **Runtime Host**s ([ADR-0011](docs/adr/0011-figma-announce-protocol-in-core.md)). `prev` and `next` are `uid → broker_id` maps: the broker each Bridge ID is on. It returns `Vec<FigmaPublish> { broker_id, topic, payload, retain }`:

- a uid that **left** its broker publishes `microflow/{uid}/app/status = "disconnected"` (retained) there;
- a uid that **arrived** on a broker publishes `"connected"` (retained) there and requests its current variable values (`microflow/{uid}/app/variables/request`);
- a uid that **moved** broker does both: it leaves the old one and arrives on the new one;
- every departure comes before every arrival, so a move between two broker ids that name one server ends on `connected`.

Topics, payloads, retain flags and order are policy and live once. Each host builds the maps from its own **live** subscriptions and performs the publishes ([ADR-0010](docs/adr/0010-subscription-diff-stays-per-host.md)): `bridge_uids` on the desktop [CloudPerformer](#cloudperformer), `uidBrokers` (`apps/web/src/cloud/mqtt-subscriptions.ts`) in the [Browser CloudPerformer](#browser-cloudperformer), which reaches the policy through the wasm `figmaAnnounceActions(prevJson, nextJson)` binding. Only [Design-Tool Bridge](#design-tool-bridge) topics count, via core's `bridge_uid` and the TS `bridgeUid`, so a generic Mqtt node's `microflow/…` topic never announces ([ADR-0028](docs/adr/0028-design-tool-bridge-protocol.md)).

Host rules around the policy, the same on both:

- **Subscribe before announce.** The maps follow the live set after the (un)subscribes, so a Bridge ID is announced once a subscription is in place to catch the plugins' answer.
- **A Bridge ID stays where it was announced** while that broker holds one of its topics; only then does it leave and arrive on another broker that holds it.
- **Announced is what the broker took.** A Bridge ID counts as announced on a broker once its `connected` went out there; one that did not get through arrives again with a later reconcile.
- **A down link.** The desktop announces nothing on a link that is down: an arrival waits for it, a `disconnected` is owed until the link is back or the [Broker session](#broker-session) ends, and a `disconnected` that failed on a link that is up is owed the same way. Right after an owed `disconnected` goes out, `connected` is said once more on the broker the Bridge ID is on now. A browser connection that is replaced, closed or disposed while its link is up says `disconnected` first.
- **Goodbyes need no engine.** The browser asks the policy for each broker's goodbye at announce time; the desktop leaves its goodbyes with the pool as the session's last words. A goodbye is said even when the engine that runs the policy has died. In the browser the policy crosses the [RuntimeBridge](#runtimebridge) like every call into the engine.

The transitions are one table, `FIGMA_ANNOUNCE_CASES` (`apps/web/src/lib/figma-announce-cases.ts`): the compiled policy is checked against it through the wasm binding (`runtime/figma-announce.wasm.test.ts`), and so is the TypeScript stand-in the browser performer's tests run on.

## Cloud Node Registration

Cloud nodes register like every other node. They are sans-IO ([ADR-0009](docs/adr/0009-cloud-sans-io-capability.md)), so `Mqtt`, `Llm` and `Figma` live in `microflow-core` (`nodes/{mqtt,llm,figma}/runtime.rs` behind the `cloud` feature; their configs in `nodes/{mqtt,llm,figma}/config.rs`, ungated) and register in `registry.rs::register_all` through the same typed `register::<B>(name)` every built-in uses. They land in `declared()`, so the **Catalog Parity Guard** reads them uniformly. The desktop crate and the browser wasm crate both enable `cloud`, so each host gets the cloud nodes from this one place. All that is per-host is the [`EffectsSink`](#effectssink) `perform_cloud` hook and the subscriptions: the desktop [CloudPerformer](#cloudperformer) and the [Browser CloudPerformer](#browser-cloudperformer).

## Capability Trait

A Rust trait describing what the desktop host asks of one external kind, in `apps/web/src-tauri/src/runtime/services/<kind>.rs`. Consumers depend on `Arc<dyn Trait>`, never on the concrete client library. One exists: [MQTT Brokers](#mqtt-brokers).

Each Capability Trait ships with two adapters — a production impl (`MqttManager`) and a recording test impl (`RecordingMqttBrokers`) — which is what makes the trait a real seam rather than a hypothetical one (same rule as [RemoteSyncAdapter](#remotesyncadapter) + `RecordingSyncAdapter`).

See [ADR-0025](docs/adr/0025-per-capability-service-traits.md).

## LLM Provider

A stored connection to any backend that can run an LLM completion — since [ADR-0021](docs/adr/0021-one-llm-transport-in-the-webview.md) a **webview** concept in both hosts, not a Rust capability. A provider config's connection half is `LlmProviderConn` — `{ kind?: "http" | "cli", baseUrl, apiKey }` — and `adapterFor(provider, model)` in `apps/web/src/ai/adapter.ts` is the one place a config becomes a TanStack AI adapter, resolved by both AI surfaces: the `Llm` flow node's transport (`ai/llm-client.ts`, driven by the [Browser CloudPerformer](#browser-cloudperformer) in a browser and by the [Desktop Runtime Host](#desktop-runtime-host) on desktop) and Ask AI (the [Turn Runner](#turn-runner)). `"http"` speaks the OpenAI chat-completions wire shape (OpenAI, OpenRouter, LM Studio, llama.cpp, vLLM and Ollama all serve it) through `hostFetch()` (`ai/endpoint.ts`) — the page's `fetch` in a browser, the Tauri HTTP plugin's in the desktop webview, which is the entire CORS story. `"cli"` runs a local agent CLI as a subprocess (`ai/cli-adapter.ts` / `cli-providers.ts`, on the host behind the [Agent CLI Port](#agent-cli-port)) — desktop only. In Ask AI a CLI edits the flow when it can be handed the [Flow Tool Server](#flow-tool-server) for a single run, and is flagged "no flow tools" otherwise; [Host Limitation](#host-limitation) answers both. The provider settings settle like [Settled broker settings](#settled-broker-settings) (`apps/web/src/ai/llm-provider.ts`): `providers` is what is typed and `settled` follows it `PROVIDER_SETTINGS_SETTLE_MS` (500 ms) after the last edit, at once on add, delete, another default or a console command (`settleLlmProviders`). The status probe and the console's model list read `settled`, so a key being typed is not sent a keystroke at a time; the `Llm` node and Ask AI resolve a provider from `providers` at request time. The desktop actor performs no LLM I/O: `Actor::perform_cloud` forwards an `LlmGenerate` [`CloudRequest`](#cloudrequest) to the webview as an `llm-request` event, and the result re-enters through the `llm_result` command onto `ActorMsg::Inject`.

## Turn Runner

One Ask AI turn as a plain async generator — `runTurn(options)` in `apps/web/src/ai/turn-runner.ts`. Owns everything between "the user hit send" and "the reply is final": filtering the transcript's own error notices out of the history sent to the model (they are UI, not something the model said), driving `@tanstack/ai`'s `chat()` against the flow tools, mapping the stream to `TurnUpdate` patches (text so far, tools run so far, or the failure that ended it), the no-provider notice, and `MAX_ITERATIONS` (12 model↔tool round trips — enough for "add a button that toggles an LED" plus a correction, without letting a confused small model loop forever). It never throws: every failure becomes an `error: true` update, and an abort ends the turn silently with the partial text. Returns what `confirm` mode staged, as `PendingChange[]`; `mergePending` appends in staging order (entries are uid-keyed apply-thunks, and `applyChanges` runs the whole set in one transaction, so a later change to the same node wins by ordering — one undo step). In `confirm` mode the flow tools validate against the flow with this turn's staged edits laid over it (`stagedFlow`, `ai/flow-tools.ts`), which is also what `get_flow` returns, so a turn can build on its own earlier steps; the view covers one turn and does not see what an earlier, unanswered turn staged. A staged settings change that takes a handle off a node also stages the removal of the edges there, each listed for approval. The [LLM Provider](#llm-provider) adapter is taken as a **lazy resolver** at the `adapterFor` seam ([ADR-0021](docs/adr/0021-one-llm-transport-in-the-webview.md)) — a resolution failure is this turn's error like any other, not a new seam. No React inside: `use-ask-ai.ts` is state plumbing over it, and the whole loop is testable against a fake adapter (`kind`/`name`/`model`/`chatStream`/`structuredOutput` suffice).

## Flow Tool Server

Ask AI's tools, published where an agent CLI can call them — `withFlowToolServer(port, options, run)` in `apps/web/src/ai/mcp-bridge.ts`, over the MCP server in `apps/web/src-tauri/src/mcp/` that it reaches through the [Agent CLI Port](#agent-cli-port) ([ADR-0024](docs/adr/0024-flow-tools-over-mcp-for-agent-clis.md)). A print-mode CLI has no wire format for `chat()`'s tools and runs its own agent loop, so the tools are not serialised into its prompt; they are published on a unix socket (a named pipe on Windows) that the CLI reaches by spawning `microflow --mcp <token>` — the same binary in a mode that returns before Tauri boots. Every `tools/call` is a round trip back up into the webview, because the tools mutate the Yjs `FlowDocument` and a Rust copy would be a second definition of every one of them. Each tool is published with the JSON Schema it arrives with (derived by `chat()` from the tool's zod schema), and that same schema is the gate: a call whose arguments it does not accept runs nothing and answers with a tool error naming each field. Exposure is a **session**, not a server: `withFlowToolServer` opens one for the length of a turn and closes it in a `finally`, an idle app answers `tools/list` with `[]`, and a client that does not present the session token sees the same nothing. The agent loop being inside the CLI is what the bounds are for — a 40-call budget (`CALL_BUDGET`), a 30-second deadline per call, close-fails-everything-in-flight, and one live session so a broadcast event cannot apply a write twice. Stop arrives as the turn's abort signal (`request.signal`): it closes the session, which cuts a running CLI off from the flow, and ends the CLI's [Agent CLI run](#agent-cli-run); a turn stopped before its CLI has started never starts it. `CliProvider.mcpArgs` (`ai/cli-providers.ts`) says how one CLI is pointed at a server *for a single run*, and its absence is what [Host Limitation](#host-limitation) reports as "no flow tools".

## Agent CLI Port

The webview's seam to the host that runs an agent CLI and serves its [Flow Tool Server](#flow-tool-server) session — `AgentCliPort` in `apps/web/src/ai/agent-cli-port.ts` ([ADR-0039](docs/adr/0039-agent-cli-port.md)). Five methods: `run({ bin, args, stdin, signal })` (one process, stdout as one string, a rejection whose message is fit to show; the run ends with its process when `signal` aborts), `openSession({ token, tools, budget })` (the relay command to spawn, or `null` when no MCP transport is listening), `onToolCall`, `answerToolCall` and `closeSession`. `cli-adapter.ts` and `mcp-bridge.ts` take it as a dependency and import no Tauri. Everything that is logic stays above it: the argument vector, the prompt, the session token, the tool roster, the call budget, the argument gate, which session may answer a call and when a session closes. The production adapter is `tauri-agent-cli.ts` — one Tauri primitive per method (`run` is two: `llm_cli_generate` under a run name it makes, and `llm_cli_stop` with that name when the signal aborts) and no decision of its own; `tauri-agent-cli.test.ts` pins every command, argument and event name it sends against the Rust source. Not a transport seam for LLM calls: that is `adapterFor` ([LLM Provider](#llm-provider)).

## Scripted Agent CLI

The test-side [Agent CLI Port](#agent-cli-port): `scriptedAgentCli(script)` in `apps/web/src/ai/scripted-agent-cli.ts`. A script is what one process did, in order — wrote to stdout or stderr, called a flow tool over MCP, held, exited — played back one step per turn of the event loop. It keeps the host rules the code above the port depends on: stdout arrives whole after exit; one session at a time; a call is checked token, then roster, then budget before it is sent up; closing fails every call in flight. It records `runs`, `sessions` and `toolResults`. The 30-second call deadline is not modelled. Nothing in the app imports it.

## Agent CLI run

One agent CLI process the desktop host started under a name the webview gave it (a `uid()` per run), owned by `AgentCliRuns` (`apps/web/src-tauri/src/cli_llm/runs.rs`, [ADR-0047](docs/adr/0047-the-desktop-host-owns-agent-cli-process-trees.md)) until it ends: it exits, its turn's signal aborts (`llm_cli_stop { run }`), the page that asked for it reloads (`cli_llm::page_gone`), or the app quits (`cli_llm::quit`). Ending a run ends its whole process tree: on unix its process group, asked with `SIGTERM` and killed with `SIGKILL` after `STOP_GRACE` (2 s); on Windows its job object. A stop for a run that is over finds nothing; a stop that arrives before its run (up to 32 are kept) keeps the run from starting. The flow tool session closes at the stop.

## MQTT Brokers

The [Capability Trait](#capability-trait) for the desktop broker pool: every broker the app is connected to, addressed by broker id. `MqttBrokers` in `apps/web/src-tauri/src/runtime/services/mqtt.rs`. It is everything the desktop [CloudPerformer](#cloudperformer) asks of the pool:

```rust
async fn session(&self, broker_id: &str) -> Option<BrokerSession>;
async fn publish(&self, broker_id: &str, topic: &str, payload: &[u8], retain: bool) -> Result<(), MqttError>;
async fn subscribe(&self, broker_id: &str, topic: &str, on_message: MessageCallback) -> Result<u64, MqttError>;
async fn unsubscribe(&self, broker_id: &str, topic: &str) -> Result<(), MqttError>;
async fn set_last_words(&self, broker_id: &str, session: u64, words: Vec<LastWord>);
fn changes(&self) -> watch::Receiver<u64>;
```

`subscribe` returns the id of the [Broker session](#broker-session) that holds the subscription; success means the SUBSCRIBE went out on the link. `set_last_words` leaves with a session what it says when it is ended on purpose, and so its will. `changes` ticks when a session starts, ends or gets its link back. `MqttError::BrokerNotConnected` is distinguished from `MqttError::Failed` so callers can prompt for a reconnect instead of surfacing a generic wire error.

Production adapter: `MqttManager` (`apps/web/src-tauri/src/mqtt/manager.rs`), the pool itself, which also serves the [Connection Console](#connection-console)'s commands. Test adapter: `RecordingMqttBrokers`, an in-memory pool that keeps what the real one keeps (one session per connected broker, one callback per topic, forgotten when the session ends), records every call in order, and can be scripted to fail a call, hold a subscribe back, drop a link or deliver an inbound message.

In the pool a subscription belongs to a **subscriber**, `Subscriber::Flow` or `Subscriber::Console` (`mqtt/broker.rs`): both can hold the same topic filter, each with its own callback and delivery. The trait subscribes as `Flow`. A joiner gets the filter's retained messages; a message flagged RETAIN goes to a subscriber only if it has had no message on that exact topic since it joined. A message matching several of the client's filters reaches each once: the copies a broker may send for the other filters within `COPY_WINDOW` (50 ms) go to nobody. Matching follows the table both hosts share ([ADR-0048](docs/adr/0048-routing-overlapping-subscriptions.md)).

## Host Adapter

Frontend mirror of **Wiring**. Each node folder may hold a `<node>.adapter.ts` that exports an `adapter: NodeHostAdapter` (see `apps/web/src/nodes/_base/host-adapter.ts`) describing what the host store + global hotkey listener need from this node:

- `prepareData(node, hosts)` — partial `data` patch to merge before sync (e.g. `Figma` injects `uniqueId` from `useFigmaStore`).
- `brokerIds(node)` — broker IDs this node depends on; collected and forwarded to the runtime.
- `accelerator(node)` — keyboard accelerator this node listens to. `hotkeyAccelerators` (`apps/web/src/runtime/hotkey-accelerators.ts`) collects one per case-insensitive identity for `useHotkeys` to register; which nodes hear the key is core's ([Host input](#host-input)).

The file's presence drives codegen: when `<node>/<node>.adapter.ts` exists, `catalog.generated.ts` imports its `adapter` export. The adapter file stays React-free, so the catalog never loads a node's UI. `NODE_CATALOG` exposes `adapter` on every entry (undefined when no adapter is needed), so consumers walk it without pattern-matching `data.instance`.

## Broker binding

How a node that talks through an MQTT broker (Mqtt, the design variable node) is bound to one of the brokers the user configured: `apps/web/src/nodes/_base/broker-binding.ts`. The node holds a broker id in its `brokerId` setting; `useBrokerBinding(brokerId)` answers with the broker it names, why the node cannot reach a broker (none configured, none selected, out of this host's reach), and the Leva select for the setting. Brokers with the same name are told apart in the select by their address, without credentials, and by their id when that is the same too; the stored value is always the id. The Host Adapter half, the broker ids a flow depends on, is the React-free `broker-binding.adapter.ts`.

## Song editor

The one editor for a node's song, shared by Piezo and Midi: `apps/web/src/nodes/song/`. It knows a note's pitch and duration only.

- **Note shape** — what a node's notes carry beyond pitch and duration (`NoteShape`, `song/notes.ts`): the blank note a new slot starts as, what its badge says, and the controls for the rest. Piezo's note is two slots; Midi's adds a velocity slot.
- **Song draft** — the song being edited (`SongDraft`, `song/song-draft.ts`): the notes with an id each, changed by plain functions the dialog calls (`added`, `removed`, `replaced`, `swapped`). Stored songs keep their shape.

## Live Handle Set

The Ports and Emits a node offers for connection, given its type and its
current settings: `liveHandles(type, data)` in `apps/web/src/nodes/handles.ts`,
returning `{ ports, emits }`. Total — it answers for any `data` and never
throws; a setting that is missing or unusable reads as the node's default. Ids
are unique per side; a Port and an Emit may share one (`value`). One answer for
every reader: [NodeHandles](#nodehandles) renders it, the canvas refuses a
dragged connection that is not in it (`isValidHandleConnection`), the session
prunes against it ([Handle pruning](#handle-pruning)), Ask AI's `connect` and
node catalogue, the template guard and the flow file read it. The same module
gives `nodeHandles(node)` (`null` for a type this build does not know),
`handleVariants(type)` (every handle set a type can have and the settings that
select each) and `checkEdge` / `checkEdgeEnds`, whose `EdgeProblem` is
`missing-node`, `unknown-type`, `unknown-handle` (nothing declares it) or
`not-offered` (the component declares it; the node does not offer it as
configured — `offered: "other-settings" | "never"`). Not the wire interface:
`COMPONENT_PORTS` / `COMPONENT_EMITS` list what a component declares for any
settings ([ADR-0007](docs/adr/0007-node-wire-interface-emit-contract.md)); the
live set is the part a node offers now, plus its [Open ports](#open-port). An
editor concept: the runtime routes by `ports()` / `emits()` and never sees it.
**One set:** over all of a node's settings, the handles it offers are the handles its component declares, the runtime takes and the sketch honours. The exceptions are a Port the host delivers (Hotkey `key_event`), an alias (Servo `rotate`), the implicit `value` Emit on a node that draws a named output (or Monitor), and open ports; `nodes/handles.test.ts`, `codegen/parity.rs` and `catalog_parity.rs` hold the set together ([ADR-0044](docs/adr/0044-declared-drawn-and-honoured-handles-are-one-set.md)).
Decided in [ADR-0032](docs/adr/0032-live-handle-set-and-handle-pruning.md).

## Handle Rule

A node's handles as a function of its settings, stated once:
`apps/web/src/nodes/<node>/<node>.handles.ts` exports `handles =
defineHandles<"T", Data>(layout, options)` (types in
`nodes/_base/handle-rule.ts`). `layout(settings)` returns the node's `PortSpec`s
and `EmitSpec`s in render order, with how each is drawn (`kind`, `offset`,
`title`, `hint`, `side`); it receives the settings as the flow document holds
them and must answer for any value. A Port id is typed `PortOf<T>` and an Emit
id `EmitOf<T>`, so a renamed Rust handle stops the file compiling. `variants`
indexes the settings that select each distinct handle set (Mqtt: `direction`),
`variantsFollow` says what those settings follow when nobody sets them directly
(a design variable's type), and `openPorts` says in words what names a node's
[Open ports](#open-port). `nodes/handle-rules.ts` holds one line per
[Component Catalog](#component-catalog) entry and does not compile while an
entry lacks one; a [Variant](#variant) uses its parent's rule. React-free.
Internal to the nodes vertical: other code asks the
[Live Handle Set](#live-handle-set).

## Open port

A Port named by the node's own settings rather than declared by the component:
one per `{{variable}}` in a Function's `code` or an Llm's `prompt`, one per
Music record. The component accepts it under any name, so it is in no
generated list and its [Handle Rule](#handle-rule) marks it `open: true`. An
open port can be `hidden` — connectable but not drawn, because the node has no
room for it; whether a handle exists never depends on room. Open ports are in
the [Live Handle Set](#live-handle-set) and absent from `handleVariants`' sets.

## Handle pruning

Removing the edges at a handle that leaves a node's
[Live Handle Set](#live-handle-set): `startHandlePruning` in
`apps/web/src/session/handle-pruning.ts`, run by every session for as long as
it may write (`pruneWhileWritable`, `session/flow-session.ts`) beside the
dangling-edge prune (`FlowDocument.startEdgePruning`: an edge whose node a peer
deleted). The trigger is the document — node `data` — so an edit by a settings
panel, Ask AI, a flow tool, undo or a collaborator prunes alike, with no canvas
mounted. It reacts to a handle **vanishing**, never to an edge being there: an
edge at a handle that is not offered is left alone, and starting does not sweep
the document. A node written whole (a template, an import, the stored document
loading, a `type` change) is new content and is not pruned; nor is a change
from outside in a session that has never been in sync with its room. A session
catching up after having been live records the handles that vanish and removes
their edges when it is live again. After the user's own edit the removal joins
the same undo step; every other removal is written with `PRUNE_ORIGIN`, outside
undo. A removal made while live is remembered with its cause. When this client's undo or redo of its own change, or a concurrent value of the setting winning, gives the handle back, the edge is restored under its own id, with `PRUNE_ORIGIN`; a handle given back by a new change (a value set back by hand) restores nothing. The session imports nothing from `nodes/`: `wireApp()`
(`apps/web/src/app-wiring.ts`) hands it `nodeHandles` once through
`provideHandleSets`, and a writable session without them reports once through
`reportError`. Decided, with its accepted residue, in
[ADR-0032](docs/adr/0032-live-handle-set-and-handle-pruning.md).

## NodeHandles

The one place a node's edge handles are rendered:
`apps/web/src/nodes/_base/node-handles.tsx`. `<NodeHandles />` takes the node's
type and settings from the `NodeContainer` around it and renders the layout its
[Handle Rule](#handle-rule) returns — one **target** `Handle` per Port (left
unless the rule gives a side), one **source** `Handle` per Emit (right) — so a
node's handles follow its settings with no code of its own, and the canvas
agrees with every other reader of the [Live Handle Set](#live-handle-set). The
one handle it leaves out is an [Open port](#open-port) the rule marks `hidden`:
connectable, with no room to draw it. It tells ReactFlow to re-measure the node
when the rendered handles change. The override maps (`portOverrides`,
`emitOverrides`) carry only what depends on the host and not on the node
(`HandleOverride`: `hint`, `isConnectable`, `isValidConnection`); binding the
generic (`<NodeHandles<"Led"> …>`) checks their keys against `PortOf<T>` /
`EmitOf<T>`. Not a declaration: it holds no handle list, and no node renders a
`Handle` of its own.

## Host Limitation

Why something cannot run in the current host — `hostLimitation(subject)` in `apps/web/src/nodes/_base/browser-support.ts`, the one resolver for every host-gated subject, so no two surfaces can disagree about the answer or the wording. The flow engine registers every node in both hosts (see [Cloud Node Registration](#cloud-node-registration)), so every gap is a *host* gap: an OS capability the browser sandbox does not hand out, or hands out only on some browsers. Three subject kinds: a node **type** (`{ kind: "node", type }` — no Web Serial makes every `requiresHardware` node inert, no Web MIDI gates `Midi`, both per *browser*), a broker **URL** (`{ kind: "broker", name, url }` — a browser can only speak MQTT over WebSocket, so a non-`ws(s)://` broker never connects there; a *blank* URL is unconfigured, not a host gap), and an [LLM Provider](#llm-provider) **on a surface** (`{ kind: "provider", provider, surface: "config" | "node" | "ask-ai" }` — a CLI provider is a subprocess no browser tab can start, so a browser excludes it everywhere; on desktop only `ask-ai` can still object, and only for a CLI that cannot be handed the [Flow Tool Server](#flow-tool-server) for a single run). The answer is `{ label, reason } | undefined` — a short badge label plus the sentence behind it. Callsites (the node badge in `desktop-only-badge.tsx`, the `Mqtt`/`Figma` node bodies, the MQTT config page, the Ask AI panel and provider picker) render the answer and never author a predicate or a sentence; `isDesktop()` is read inside, so no caller can disagree about which host it is running on.

## Connection Console

The terminal-like panel on a configuration page for one kind of stored connection: MQTT brokers (`routes/configuration/mqtt.tsx`) and LLM providers (`routes/configuration/llm.tsx`). `ConnectionConsole` in `apps/web/src/cloud/connection-console/connection-console.tsx` renders it. The user selects a connection, types commands, and reads the transcript: `subscribe` / `unsubscribe` / `publish` for a broker; `ask` / `model` / `system` / `test` for a provider; `clear` and `?` for both. It is a real client of the connection, not a view of the flow's traffic.

- **Console Session** — the module behind one console (`ConsoleSession`, `console-session.ts`): the selected connection, its transcript (300 lines, emptied on a switch), the command grammar and what each verb does. One per connection kind: `createBrokerConsoleSession` and `createLlmConsoleSession`. No React and no DOM; `useBrokerConsole` / `useLlmConsole` (`use-console-session.ts`) keep one live for as long as the page is mounted. A reply to a command run under an earlier selection is dropped.
- **Broker Transport** — the seam between the broker console and a host's MQTT client (`BrokerTransport`, `broker-console-session.ts`), with one adapter per host in `broker-transport.ts`. On desktop it drives the pool over IPC (`mqtt_subscribe`, `mqtt_unsubscribe`, `mqtt_publish`) and listens to the `mqtt-message` host event, which flow nodes share: the session keeps a message only when it is from the selected broker and matches one of the console's own filters. In a browser it opens its own `mqtt.js` connection, separate from the [Browser CloudPerformer](#browser-cloudperformer)'s.
- **Broker Link** — the console's hold on one broker while it is selected (`BrokerLink`: `subscribe`, `unsubscribe`, `publish`, `close`). The transport's `linkKey` says what a link is tied to: the broker id on desktop, the broker id, URL and login in a browser. The session is given [Settled broker settings](#settled-broker-settings) and settles what is typed before it runs a command. The session replaces the link when that key changes.

The LLM console has no transport seam: there is one LLM transport, in the webview on both hosts ([ADR-0021](docs/adr/0021-one-llm-transport-in-the-webview.md)), so `ask` is the call an `Llm` node makes.

## Node-Data Commit

The last hop where a node's control edits become CRDT writes — `createNodeDataCommitter({ doc, nodeId, readOnly, schedule? })` in `apps/web/src/nodes/_base/node-data-commit.ts`, plain TS so the commit policy is testable without Leva or ReactFlow (`useNodeControls` is the Leva adapter over it). Three operations: `commit(values)` — deferred through `schedule` (rAF in the app, injectable in tests) and latest-wins coalesced; `forceCommit(values)` — the `setNodeData` escape hatch for values the controls cannot express, written immediately and therefore *ahead* of any scheduled commit; `reconcile(docData, controlValues)` — the doc changed under the controls (remote edit, undo/redo, or the echo of our own write), returning the patch of declared keys to replay into them, or `null` when they already agree. The committer owns the write ordering (forceCommit first, controls commit last), per-key echo suppression via a `lastKnown` basis (no write-back loop after a remote edit is replayed; our own echo does not stomp the controls mid-edit), and the `readOnly` guard (a read-only [FlowSession](#flowsession)'s committer never writes — the cheap first line before the [Read-Only Document](#read-only-document) proxy). Writes go per-field through `FlowDocument.updateNodeData` ([ADR-0019](docs/adr/0019-nested-node-fields-for-concurrent-edits.md)), so a data field the control schema does not declare — a Function node's `code` — is deliberately preserved: never written, never deleted, never replayed.

## Node Data Resolver

`resolveNodeData(type, patch, base?)` in `apps/web/src/nodes/node-data-resolver.ts` — the one path from "a node type plus a patch of config fields" to a complete, schema-valid node `data` object: the type's `NODE_CATALOG` defaults (codegen'd from the [Component Catalog](#component-catalog)), the optional existing node's `base`, the `patch` on top, validated by the node's own zod schema. Returns `{ ok: true, data }` or `{ ok: false, error }` with the schema issues spelled out. Presentation keys (label/icon/group) live on `defaults` but not in the schema, so the merged object is kept and the parse only proves validity — the caller may send just the field it cares about and still get the same complete node the picker places by hand. Three callers share it. The two authoring paths, Ask AI's flow tools (`ai/flow-tools.ts`, behind the [Turn Runner](#turn-runner)) and the built-in templates (`flows/templates`, authored as `(type, overrides)` pairs), cannot ship data the node itself would reject. The [Flow File](#flow-file) codec (`flows/flow-file.ts`) uses it to complete an imported node's settings with their defaults; when the resolver would refuse or change a value the file has, the codec keeps the file's settings as they are and says so in a [Flow File Notice](#flow-file-notice). Edges have the matching check: `checkEdge` against the [Live Handle Set](#live-handle-set).

## Flow File

The JSON text a flow is exported to and imported from: `{ meta, data: { nodes,
edges }, version, exportedAt }`, where `version` is the format's
(`FLOW_FILE_VERSION`, 1), not the flow's. One codec,
`apps/web/src/flows/flow-file.ts`
([ADR-0041](docs/adr/0041-flow-file-is-a-load-boundary.md)): `encodeFlowFile`
writes it, and `decodeFlowFile(text)` is the load boundary for a file. Decode
is total: any text gets `{ ok: true, flow, notices }` or `{ ok: false, problem
}`. A file is refused only when it cannot be a flow: not JSON, no nodes and
edges, a node or edge without a usable id, an edge without ends, a duplicate
id, a newer or malformed version, or a file beyond the limits (64 MB, 5,000
nodes, 20,000 edges, 64 levels of nesting). Everything else is read as a
stored flow with the same defect is opened: nodes through `FlowDocument`'s own
read path, settings through the [Node Data Resolver](#node-data-resolver), and
edges through `decodeEdge` (`packages/collab/src/schema.ts`), the reading the
document gives a stored edge: every edge is kept except one to a node that is
not in the file and one that names no handle at an end. The document reads a
stored edge the same way: `FlowDocument.getEdges` / `getEdge` / `getFlowData`
leave out an edge with no usable id, source or target, or with no handle at an
end, and that edge stays in the document, unshown and unrun. Not the stored
document: a flow is persisted as a Yjs document ([RoomStore](#roomstore),
[IndexeddbSyncAdapter](#indexeddbsyncadapter)), and a Flow File is only a
snapshot of its nodes and edges. `importFlowFile` (`flows/import-flow.ts`)
turns a decode into what to tell the user; the picker and the toasts are in
`flows/use-flow-import-export.ts`.

## Flow File Notice

One thing `decodeFlowFile` did not take over from a [Flow File](#flow-file)
unchanged: `FlowFileNotice { kind, id?, message }`. Eight kinds:
`name-shortened`, `unknown-node-type` (kept, will not run),
`position-defaulted`, `settings-defaulted`, `settings-unrecognised` (kept
exactly as in the file), `edge-dropped` (the only kind where content is left
out), `unknown-handle` (kept, carries nothing), and `edges-not-drawn` (once
per file, for edges at a handle their node declares and does not offer as
configured). A file this build exported decodes with none. Not a refusal: a
refused file has a `problem` and no flow.

## Open flow from content

The one landing rule for a flow that arrives as nodes and edges:
`openFlowFromContent(content, destination, landing)` in
`apps/web/src/flows/open-flow.ts`, bound to the app by `useOpenFlow`
(`flows/use-open-flow.ts`). Signed in, the content lands in the user's account,
as a new flow the caller's `FlowDestination.account` creates; signed out, it
replaces the local flow. The flow it
landed in then becomes the active flow and the editor opens it. A failure is
an `ok: false` result and changes nothing else; content the account did not
take never lands in the local flow instead. Three callers: a
[Flow File](#flow-file) import (`flow.createFromImport`), a Community fork
(`community.fork`), and a template through `openTemplate`
(`flows/templates/open-template.ts`): `flow.createFromImport` under the
template's name, a new flow on each choice
([ADR-0042](docs/adr/0042-a-template-lands-in-the-account.md)).

## FlowSession

Live editing context wrapping a **FlowDocument** plus a **SyncAdapter**. Lives in `apps/web/src/session/flow-session.ts`. A plain object: `{ flowId, mode, role, readOnly, doc, sync, status, destroy }`, where `status` is its [Flow Session Status](#flow-session-status). Held by a **FlowSessionProvider** (one per route layout) and retrieved by `useFlowSession()` — which throws if called outside a provider, so consumers get type-narrowed access (`FlowSession`, never `FlowSession | null`) inside the subtree. Three factories: `createLocalSession()` pairs a fresh `FlowDocument` with an `IndexeddbSyncAdapter` (`readOnly: false`); `createCloudSession({ flowId, user, wsUrl, authToken, initialData?, role? })` pairs a `FlowDocument` (seeded from `initialData` if provided, with history cleared so undo cannot unwind into an empty document) with a `SyncProvider`, which satisfies [RemoteSyncAdapter](#remotesyncadapter) directly; `createPreviewSession(nodes, edges)` pairs a fresh `FlowDocument` with a `NoOpSyncAdapter` for read-only thumbnail surfaces (`readOnly: true`). `destroy()` tears down the sync adapter, then the doc, in that order.

`role` carries the local user's [Flow Role](#flow-role) on a cloud flow (`null` for local flows and previews), sourced from `flow.get` by the `/flow/$flowId` route and overridden by [Live access](#live-access). `readOnly` is true for previews and for a Viewer — the Yjs room drops a Viewer's writes, so accepting them locally would diverge the two documents in silence. Three consumers act on it: the [Node-Data Commit](#node-data-commit) committer refuses to write (without that, Leva's per-render `controlsData` identity churn would write to the preview doc on every render and, with no `ReactFlowBridge` to absorb the echo, loop); [ReactFlowBridge](#reactflowbridge) suppresses structural writes; the canvas disables dragging, connecting and deleting through ReactFlow's own props. Everything else reaches the doc directly, so `makeSession` wraps it in a **Read-Only Document** when `readOnly` is set. A session that may write also keeps its document repaired for as long as it may ([Handle pruning](#handle-pruning)); a Viewer and a preview never prune.

## Flow Session Status

The one derived answer to "can I trust what I see, and will my edits keep?" — `apps/web/src/session/session-status.ts`, a pure reducer bound to the transport's events (a cloud `SyncProvider`) or to the local store's state (`IndexeddbSyncAdapter.state`). Its `kind` is one of `local`, `local-slow`, `local-unsaved`, `connecting`, `syncing`, `connected`, `saving`, `saved`, `read-only`, `offline`, `access-lost`, with the unsynced-change count, last save time, why access was lost and whether the server is restarting. The status indicator in the canvas's top-left panel renders it (`editor/panels/session-status-indicator.tsx`, wording in `editor/session-status-copy.ts`).

## Live access

What the room says a connection may do right now: a `MESSAGE_ACCESS` frame (`none` / `read` / `write`) sent on join and whenever `YjsServer.setAccess` changes it ([ADR-0015](docs/adr/0015-room-connection-owns-access.md)). It overrides the role `flow.get` returned at page load: `withLiveAccess` (`session/flow-session.ts`) flips `readOnly`, the document guard and the role, and `RemountOnAccessChange` remounts the editing surface. Demotion is immediate and keeps counting local edits that can no longer be saved; promotion reconnects.

## Read-Only Document

`readOnlyDocument(doc)` in `apps/web/src/session/read-only-document.ts` — a `FlowDocument` proxy whose mutating methods (`addNode`, `setMeta`, `undo`, …) are no-ops. One write-guard for every call site that reaches the doc directly (node dialogs, history, board-target picker) instead of a `readOnly` check at each, which the next call site would have to remember. Getters, observers and the raw `doc`/`nodes`/`edges` handles pass through, so incoming remote updates and the Yjs→React read path are unaffected. `ReactFlowBridge` writes through `doc.nodes` rather than these methods and carries its own flag; the two guards are independent on purpose.

## SyncAdapter

Base interface for the session's persistence/sync seam, mirroring the **Capability Trait** discipline on the Rust side ([ADR-0025](docs/adr/0025-per-capability-service-traits.md)). Lives in `apps/web/src/session/sync-adapter.ts`. Carries `kind: "local" | "remote"` and `destroy()`. Two-tier: extended by `RemoteSyncAdapter` for server-backed adapters. `IndexeddbSyncAdapter` and the preview `NoOpSyncAdapter` satisfy the base only — no `state`, no `users`, no `error`, because none of those are meaningful without a server. UI code narrows with the `isRemoteSyncAdapter` guard (on `kind`) to render the sync chip / collaborator panel.

## RemoteSyncAdapter

Sub-interface of **SyncAdapter** for server-backed adapters. Adds `state: SyncState`, `isSynced: boolean`, `users: AwarenessUser[]`, `localUser: AwarenessUser | null`, `error: Error | null`, the presence writers (`updateCursor`, `updateSelectedNodes`, `updateDraggedNodes`), `reconnect`, `disconnect`, and an `on(event, cb): () => void` subscription surface (events: `"state"`, `"awareness"`, `"synced"`, `"error"` — the connection/presence subset of the provider's events; `ack` and `accessDenied` stay a transport concern). Satisfied **structurally by `SyncProvider` itself** (`packages/collab/src/sync-provider.ts`) — no wrapping adapter class; the `RemoteSyncAdapter` annotation in `createCloudSession` is the compile-time proof ([ADR-0023](docs/adr/0023-one-presence-module-owns-the-awareness-field-set.md)) — and by `RecordingSyncAdapter` in tests. Not satisfied by `IndexeddbSyncAdapter`. The two-tier split is type-honest — local sessions don't lie about being "synced to nothing." Presence *reads* go through [Presence](#presence) slices rather than raw `users`.

## IndexeddbSyncAdapter

The local-persistence `SyncAdapter` (`kind: "local"`). Lives in `apps/web/src/session/indexeddb-sync-adapter.ts`, backed by `y-indexeddb`'s `IndexeddbPersistence` ([ADR-0020](docs/adr/0020-lean-on-the-yjs-ecosystem.md)): Yjs updates persist incrementally — no JSON round trip, no whole-document write — and the document's history survives a reload. The document name (`microflow-local-flow` by default) is the storage key. `whenSynced` resolves once the stored document has loaded, running `upgradeLegacyNodes` at the load boundary — the same [ADR-0019](docs/adr/0019-nested-node-fields-for-concurrent-edits.md) shape upgrade the server's room store applies. `whenSynced` always settles: it rejects with a `LocalPersistenceError` (`open-failed`, `timeout` after 15 s, `destroyed`) instead of hanging when IndexedDB will not open. `state` (`loading → stalled → synced | failed`) and `onStateChange` let the [Flow Session Status](#flow-session-status) follow a slow store that recovers. No connect/disconnect concept; `destroy()` detaches the observer and closes the database handle (applied updates are already durable, so there is no final flush).

## RecordingSyncAdapter

The test-side `RemoteSyncAdapter`. Lives in `apps/web/src/session/recording-sync-adapter.ts`. Mirrors the `RecordingMqttBrokers` ([ADR-0025](docs/adr/0025-per-capability-service-traits.md)) discipline — the second adapter that keeps the seam real. Records `appliedUpdates: Uint8Array[]`, `awarenessUpdates` (tagged `"cursor"` / `"selection"` / `"drag"`), `connectCalls`, `disconnectCalls`, `destroyed`. Scripts `injectRemoteUpdate(update)` (simulate a collaborator's edit), `injectAwareness(users)` (simulate presence), `injectState(state)` (simulate connection drop / recover), `injectError(err)` (simulate sync error). Two `RecordingSyncAdapter`s pointed at separate `FlowDocument`s can replay each other's updates in tests — the convergence property is testable without a Yjs server.

## Presence

The awareness channel, sliced by what each consumer draws — `apps/web/src/session/presence.ts` ([ADR-0023](docs/adr/0023-one-presence-module-owns-the-awareness-field-set.md)). Awareness is the editor's highest-frequency event source (every peer's pointer move lands on it), so a **PresenceSlice**`<T>` packages the pair that controls the churn: `select(peers)` derives the view and `equal(a, b)` decides whether subscribers see a change. Three slices today: `cursorsSlice` (peers that are pointing somewhere — blind to selection and drag fields, so those changes do not redraw cursors), `collaboratorsSlice` (who is in the room — blind to cursors, so the avatar panel does not re-render at pointer rate), and `remoteDragSlice` (every dragging peer's live positions flattened into one `DragMap`, `null` when nobody drags). `observePresence(sync, slice, onChange)` is the non-React core and `usePresence(slice)` the React shell; both fire only when the slice itself moves, and the local user is excluded before `select` runs. Consumers subscribe to the slice they draw (`collab-cursors.tsx`, the presence panel, `use-remote-drag.ts`). The write side is `useFlowAwareness()` — `updateCursor` / `updateSelectedNodes` / `updateDraggedNodes` on the [RemoteSyncAdapter](#remotesyncadapter), deliberately not a subscription, so publishing a cursor does not re-render the canvas on every remote pointer move. Adding a presence field costs one slice declaration.

## SessionRegistry

Module-level `Map<flowId, { session, refs, pendingDestroy }>` keyed on `flowId`. Lives in `apps/web/src/session/session-registry.ts`. `acquireLocalSession()` / `acquireCloudSession(opts)` increment `refs` (cancelling any `pendingDestroy` timer); `releaseSession(flowId)` decrements and, when `refs` hits zero, schedules `destroy()` via `setTimeout(_, 100)`. The 100ms grace period absorbs React 18 Strict Mode's mount → unmount → mount cycle (second mount lands inside the window and reuses the same instance) and fast browser back-button navigation. Production behaviour with no Strict Mode is `refs: 1 → 0 → destroy after 100ms` — perceptually instant. Keyed on `flowId` so cross-mode navigation (`/flow/abc` → `/flow/local`) fully tears down without reuse. Pattern mirrors TanStack Query `gcTime`. Render only *peeks* (`peekSession` builds without taking a reference); the reference is taken from an effect (`useRegisteredSession`), and a session no effect claims within 5 s is reclaimed, so a render React discards never leaks a socket.

## FlowSessionProvider

React Context provider component. Lives in `apps/web/src/session/flow-session-context.tsx`. Wraps an editing subtree with one `FlowSession` value. One provider mounted per route layout — `LocalFlowLayout` and `CloudFlowLayout` in `apps/web/src/routes/flow/$flowId.tsx` each own one. Children call `useFlowSession()` to read; reading outside a provider throws (`"useFlowSession must be inside a FlowSessionProvider"`) so a misplaced consumer surfaces immediately rather than silently no-op'ing. The Context value is the session reference (rare change); high-frequency reactive data (nodes, edges, sync state) bypasses Context via Y.Doc observers and `RemoteSyncAdapter.on(...)` subscriptions.

For non-editable surfaces that still render real node components (thumbnails, template cards) use the **PreviewFlowSessionProvider** wrapper (`apps/web/src/session/preview-flow-session-provider.tsx`). It seeds a throwaway `FlowSession` via `createPreviewSession(nodes, edges)` — a fresh `FlowDocument` paired with a `NoOpSyncAdapter` that doesn't persist or connect — so node components calling `useFlowSession()` resolve to a real (but ephemeral) session instead of throwing. The session is destroyed when the provider unmounts; the nodes/edges identity drives rebuilds.

## FlowUpdateDispatcher

Class that observes a `FlowSession`'s `FlowDocument` for any Y-update (local edits AND remote sync arrivals), schedules a dispatch via an injected `DispatchScheduler`, then builds a `FlowUpdate` payload and ships it through an injected `FlowUpdateSender`. Lives in `apps/web/src/runtime/flow-update-dispatcher.ts`. Five injected dependencies, each with a production and test impl:

- **`FlowSession`** — the doc to observe.
- **`HostSnapshotProvider: () => HostSnapshot`** — re-read on every dispatch so credential rotation (MQTT password, LLM API key) takes effect on the next call without rebuilding the dispatcher.
- **`FlowUpdateSender`** — transport. Production: `TauriFlowUpdateSender` (wraps `invokeCommand("flow_update", ...)`). Tests: `RecordingFlowUpdateSender` (captures every dispatched payload, supports scripted errors via `scriptError(msg)`).
- **`DispatchScheduler`** — debounce strategy. Production: `DebounceScheduler` (500ms via `@tanstack/react-pacer`). Tests: `ManualDispatchScheduler` with `.flush()` for deterministic assertions.
- **`NodeAdapterRegistry`** — minimal `Record<instance, { adapter? }>` shape the dispatcher needs from the codegen'd `NODE_CATALOG`. Injected (not imported) so tests hand the dispatcher a stub with exactly the adapters they exercise.

The pure compositional helpers, each independently testable:

- **`applyHostAdapterPatches(nodes, hostState, registry)`** — walks each node's **Host Adapter** to apply `prepareData` patches and collect broker IDs. Returns `{ nodes, brokerIds }`.
- **`gatherBrokers(brokerIds, allBrokers)`** — filter + project to the wire shape the runtime expects.
- **`gatherProviders(allProviders)`** — project LLM provider configs to the snake-case wire shape.
- **`buildFlowUpdate(doc, snapshot, registry)`** — composes the three helpers into a complete `FlowUpdate`. Pure: same inputs → same payload.

Mounted for both hosts by `useFlowUpdateDispatcher(session)`, which picks the sender — `TauriFlowUpdateSender` on desktop, `WasmFlowUpdateSender` (the browser's `FlowReactor.applyFlow`, which reports whether it reached a live runtime) otherwise — so no platform branch lives inside the dispatcher. A failed send is retried on a `DispatchRetryPolicy` and, once the attempts are spent, reported once per run of failures as a toast. Construction fires an immediate dispatch so the runtime gets the current flow on mount. Because the observer fires on every Y.Doc mutation regardless of origin, remote collaborator edits arriving over the [RemoteSyncAdapter](#remotesyncadapter) also dispatch to the local runtime, keeping the native runtime in sync with whatever the user sees on screen.

## Flow Structure

The **Flow** minus how it looks: node id / type / config `data`, plus edge
endpoints (`source`, `sourceHandle`, `target`, `targetHandle`), both sorted.
Visual fields — `position`, `selected`, `dragging`, dimensions — are stripped.
Lives in `packages/collab/src/schema.ts` as `projectFlowStructure(nodes, edges)`
returning a `FlowStructure` of `StructuralNode[]` / `StructuralEdge[]`, with
`flowStructureKey()` giving it a string identity.

Inputs are structurally typed, so the collab `FlowNode`, a ReactFlow `Node` and
the `FlowUpdate` wire shape all project without an adapter.

It is the single answer to "did anything downstream-relevant change?", and has
three consumers:

- **`FlowUpdateDispatcher`** — `runtimeRelevantKey` delegates to it, so a node
  move does not re-dispatch the flow to the runtime.
- **Sketch code view** — the codegen dedupe key, so moving a node does not
  re-run Arduino codegen.
- **`useFlowStructuralNodes(doc)`** (`apps/web/src/session/use-flow-nodes.ts`) —
  re-emits the node array only when the key moves, so the reference survives a
  drag and the tscircuit netlist is not rebuilt.

Distinct from the **Flow Document**'s no-op write guard, which stops an
*identical* write from becoming a Yjs update at all: `updateNode`,
`updateNodePosition`, `updateNodeData` and `updateEdge` return before opening a
transaction when the prospective value is already stored (`isValueEqual`,
`packages/collab/src/schema.ts`). `addNode` / `addEdge` are unguarded — adding
is a genuine intent.

## ReactFlowBridge

Bidirectional reconciler between a `FlowDocument` (Y.Doc CRDT) and the [ReactFlow](https://reactflow.dev) change protocol. Lives in `apps/web/src/session/react-flow-bridge.ts`. One instance per canvas mount; the hook `useReactFlowBridge(doc)` constructs and tears down via `useState` lazy init + `useEffect` cleanup, exposes a `useSyncExternalStore`-backed snapshot. Six named invariants live on the class:

- **`classifyNodeChange` / `classifyEdgeChange`** (static, pure) — decide whether a `NodeChange` / `EdgeChange` is `"structural"` (flows to Y.Doc) or `"ephemeral"` (local React state only). `select` is always ephemeral; `position` is ephemeral while `dragging === true`, structural on drag-end; `add` / `remove` / `dimensions` / `replace` are always structural.
- **`isFlushingToDoc`** — loop guard. Set during the bridge's own `transact("local")` so the synchronous Y.Map observer fire skips the merge-back.
- **`mergeYjsIntoSnapshot`** (static, pure) — carries `selected` / `dragging` from the current React snapshot onto an incoming Y.Doc snapshot; those fields never round-trip through Y.Doc.
- **`nodeNeedsWrite`** (static, pure) — diff skip rule: if position + dimensions match the existing Y.Map entry, no write.
- **`scheduleFlush` / `flush`** — RAF-batched structural writes. Multiple `applyNodeChanges` / `applyEdgeChanges` calls in one frame coalesce into one `transact("local")` and therefore one `UndoManager` entry. `flush()` is public so tests and callers needing a write barrier (e.g. before navigation) can force the flush synchronously.
- **[Pending intent](#pending-intent) is [rebased](#rebase), never dropped** — every published snapshot is the doc with the pending intent on top, and the flush writes exactly the intent ([ADR-0004](docs/adr/0004-react-flow-bridge.md)). A node delete removes its edges too (`removeNodesWithEdges`, `session/flow-edits.ts`).

Repairing the document is not the bridge's job: the session removes dangling edges and the edges of a vanished handle, canvas or no canvas ([Handle pruning](#handle-pruning)). Each invariant is independently unit-testable with `bun test` (`session/react-flow-bridge.test.ts`, `react-flow-bridge-reconcile.test.ts`), including a convergence-via-`RecordingSyncAdapter` test that proves CRDT replay end-to-end without a React renderer. Drag-during positions never go through the doc; peers see them through [Presence](#presence) (`remoteDragSlice`).

## Pending intent

A local structural edit the [ReactFlowBridge](#reactflowbridge) has accepted but not yet written to the doc, held as a field-scoped `NodeIntent` (`remove`, `add`, or a `patch` of only the fields the user changed) or `EdgeIntent` (`remove`, `put`) until the frame's flush.

## Rebase

Re-applying [Pending intent](#pending-intent) on top of each new doc state, whether the change came from this client or a peer. Conflicts resolve as Yjs would: the local intent wins per field it touches, a peer's delete wins over a local patch, and a node being dragged keeps its local position.

## Board Bring-Up

Sans-IO state machine owning the board bring-up policy: probe → flash StandardFirmata if missing (automatically only for a [Positively identified board](#positively-identified-board), after a [Flash offer](#bridge-chip-guess) otherwise) → connect → auto-reconnect, and the `disconnected → connecting → flashing | confirmFlash → connected → error` phase transitions. Lives in `crates/microflow-core/src/bringup.rs` (value-tested transition table); events in (`PortReady`, `ProbeOk`/`ProbeFailed`, `FlashOk`/`FlashFailed`, `FlashConfirmed`/`FlashDeclined`, `ConnectionLost`, `PortGone`, `DisconnectRequested`) → `Phase` + host actions out (`Probe`, `Flash`, `ClosePort`, `ScheduleRetry`, `Notify`), mirroring the [Effects](#effects)/[EffectsSink](#effectssink) discipline. Each host's [Board Link](#board-link) is the adapter that drives it: the browser through `BringUpMachine` in `microflow-firmata-wasm` from `apps/web/src/board/board-controller-core.ts`; the desktop from `src-tauri/src/hardware/board_link.rs`. Hosts own I/O and timing only (serial ops, the [Flash executor](#flash-executor), boot/settle sleeps, retry delays, toasts keyed off `Notify` phases); the decisions live in the machine. `connectionLost` means the transport failed (the reader ended or a write was rejected); a runtime fault is never fed in as one ([ADR-0017](docs/adr/0017-wasm-fault-seam.md)).

## Board Link

The one owner of a host's connection to its board: which port is the board, the bring-up attempt on it, and the reconnect retry. Nothing else writes connection state. Both hosts feed it facts and let it decide; its I/O sits behind a seam with a fake for tests.

- **Browser** — `SerialBoardLink` (`apps/web/src/board/board-link.ts`) owns one open serial port from open to close: `probing → ready → attached → lost → closed`. A rejected write or an ended reader turns it `lost`, reported once; `disconnect()` is idempotent and writes the [Safe state](#safe-state) first. `BoardControllerCore` (`board-controller-core.ts`) holds the current link, the [Board Bring-Up](#board-bring-up) machine and the retry (250 ms doubling to an 8 s cap, 8 attempts). Seams: `Clock`, `WebSerial`; fakes in `link-fakes.ts`.
- **Desktop** — `BoardLink<Io: LinkIo>` (`apps/web/src-tauri/src/hardware/board_link.rs`), fed port scans (`scan`, every 250 ms) and session ends (`session_ended`, keyed by [Board Session](#board-session) id). Only the board's own port leaving is `PortGone`; other ports coming and going never touch the board. One probe per scan; a lost board is retried at 0/1/2/4/8 s, then shows "not responding" and re-probes quietly every 30 s while the port is present. Seam: `LinkIo` (`DesktopLinkIo` in `hardware/mod.rs`, `FakeIo` in tests).

## Board Session

The desktop actor's hold on the live port, under the `SessionId` the [Board Link](#board-link) minted for it (`BoardSession` in `apps/web/src-tauri/src/runtime/host.rs`). It reports its first real read or write failure once and decides nothing; a late report from an earlier session is ignored by id. Dropping a healthy session writes the [Safe state](#safe-state). The browser's counterpart is a `SerialBoardLink` in its `attached` phase.

## Inbound queue

The bytes a browser [Board Link](#board-link) holds between the handshake and the flow runtime attaching. Queueing starts in the same step that snapshots the [Pin seed](#pin-seed), so seed plus queue is exactly the stream the [Detection codec](#detection-codec) saw. Replayed in order once the first flow is applied, then bytes stream; bounded at 4096 chunks, oldest dropped first.

## Safe state

The bytes a host writes before it lets go of a board, so nothing the flow drove stays driven: every digital port written 0, Firmata `SYSTEM_RESET`, every port written 0 again. The second round is needed because the reset turns a pull-up input into an output driven HIGH. One encoder for both hosts: `encode_safe_state(&PinProfile)` in `crates/microflow-core/src/firmata/safe_state.rs`. Written when a browser link closes a working port (including after an engine fault), when a desktop [Board Session](#board-session) drops, at desktop app exit, and before a desktop [Respawn](#respawn). Never written over a link whose I/O already failed.

## Re-announce

The board announcing its firmware again on a live session: it rebooted (reset button, DTR pulse, brown-out) without its port closing. Read from the runtime's own decode, never the [Detection codec](#detection-codec). The runtime resets what it believed about the pins, rebuilds every hardware node, replays the board setup and restores the last output of nodes that say it is safe to (`HardwareComponent::restore_output`: Led, Relay). Lives in `crates/microflow-core/src/runtime/session.rs`.

## Reset storm

Three [Re-announces](#re-announce) within 30 s. The flow is still re-applied, but outputs a restore would re-drive are held at the [Safe state](#safe-state), each with a runtime-origin warning ("the board keeps resetting … check the board's power supply"). Ends when the board has been quiet for 30 s (held outputs are restored) or on a flow update.

## Pin Profile

What each pin of the connected board can do: its `CAPABILITY_RESPONSE` (modes per pin) and `ANALOG_MAPPING_RESPONSE` (analog channel per pin), held once — `PinProfile` in `crates/microflow-core/src/firmata/profile.rs`. The codec, the [BoardWriter](#boardwriter), a node resolving `"A<n>"`, the live pin check and the [Safe state](#safe-state) all ask it. Both hosts seed the runtime with it as `PinInfo[]` (ts-rs generated). An empty profile means no board is described: every question answers *unknown*, and `"A<n>"` falls back to the Uno layout. A profile holds at most 128 pins (`MAX_PINS`, Firmata's addressable range); an entry past that is dropped. A seed's `analogChannel` is always the board's channel for that pin, read as given: seeds are built fresh on every connect and never stored.

## Positively identified board

A USB device whose vendor and product id name an official Arduino board (vendor `0x2341` or `0x2A03` with a known product id) — `UsbMatch::Identified` from `BoardConfig::identify_usb` in `crates/microflow-core/src/flasher/mod.rs`. The only device either host may flash with StandardFirmata without asking ([ADR-0031](docs/adr/0031-positive-identification-before-auto-flash.md)).

## Bridge-chip guess

A USB device on a generic USB-serial chip (CH340, CP210x, FTDI) whose product id Arduino clones commonly use — `UsbMatch::BridgeChip { board, chip }`. The chip suggests a board but proves nothing, since the same chips sit on ESP32 boards, GPS modules and plain adapters. Such a device is probed, and connects if Firmata answers. Otherwise [Board Bring-Up](#board-bring-up) enters `confirmFlash` and both hosts show the **flash offer** ("Flash as <board> on <port>", `apps/web/src/board/flash-offer.ts`); nothing is flashed until the user confirms. An answer names the offer it answers (port + USB ids), so a stale answer never acts on another device. A device with no recognised vendor is never offered.

## Flash driver

A bootloader protocol with the transport removed: `FlashDriver` in `crates/microflow-core/src/flasher/driver.rs`, a state machine whose `start()` and `advance(input)` each return the next `FlashStep` (`reset`, `setBaud`, `flushInput`, `transact`, `delay`, `reacquirePort`, `progress`, `done`, `error`). Three exist, one per protocol: `Stk500v1Driver` (Uno, Nano), `Stk500v2Driver` (Mega), `Avr109Driver` (Leonardo, Micro); `new_driver(board, flash)` picks one from the board's `BoardConfig`. A driver owns the whole protocol: the bytes, the reset sequence, the sync retries and their timing, the baud fallback, the timeouts, when to give up. It does no I/O and never sleeps ([ADR-0038](docs/adr/0038-bootloader-protocols-once-in-core.md)). The StandardFirmata images it programs are core's too (`flasher/firmware/*.hex`).

## Flash executor

A host's runner of a [Flash driver](#flash-driver)'s steps on its serial transport. Two exist: the desktop's `executor::run` (`apps/web/src-tauri/src/flasher/executor.rs`, blocking, behind the `SerialHost` seam in `serial.rs`) and the browser's `runFlash`, reached through `flashPort` (`apps/web/src/board/web-serial.ts`, Web Serial, driving the wasm `FlashSession`). An executor owns what differs per machine and nothing of the protocol: opening and closing the port, the DTR/RTS writes of a reset, and finding a board again after AVR109's 1200-baud touch, when it re-enumerates as its bootloader. Both follow the contract in `driver.rs`: discard buffered input at the start of every `transact` unless it says `keep_input` (then read on in the input as it is); give a `transact`'s read one deadline, `timeout_ms` counted from the write, which bytes that arrive do not extend; report a short read as the bytes that arrived; close a port before opening it again. A driver has no clock, so it bounds a sync phase by counting waits, which rests on that one deadline ([ADR-0038](docs/adr/0038-bootloader-protocols-once-in-core.md)). A failed flash surfaces as the `FlashError` text, the same sentence on both hosts.

## Flow Role

The access level a user has on a cloud flow: **Owner** (the `flow.ownerId` user — full control including delete, sharing, and role changes), **Editor** (a `flowCollaborator` row with `role: "editor"` — may edit the document), or **Viewer** (`role: "viewer"` — read-only). Ranked `viewer < editor < owner`. The type, the pure resolution/enforcement helpers (`resolveFlowRole`, `assertFlowRole`) and the one transition owner (`setFlowRole`, [ADR-0022](docs/adr/0022-flow-role-transition-has-one-owner.md)) live in `packages/api/src/routers/flow-access.ts`; the access matrix is table-tested in `flow-access.test.ts`.

## Flow Access seam

`requireFlowAccess(flowId, userId, minRole)` in `packages/api/src/routers/flow-access.ts` — the single choke point where tRPC flow procedures resolve a [Flow Role](#flow-role) and enforce a minimum. Fetches the flow row, resolves owner-or-collaborator role via `resolveFlowRole`, and returns `{ flow, role }` so procedures never re-implement the check. A decision is thrown as `FlowAccessDenied` (`not-found` → "Flow not found", `denied` → "Access denied"); any other error is a failure to decide, which the websocket gate and the tRPC layer treat differently. Every flow procedure goes through it, `flow.get` included, and then makes one call into the [Flow library](#flow-library). The `/yjs/:flowId` endpoint authorizes through the same function before a room is created, mapping the resolved role onto the room's [Access](#room-connection) (`viewer` → read).

A role resolved at connect time would otherwise outlive the grant it came from, so `setFlowRole(flowId, userId, role | null)` — in the same file — is the one owner of a role transition: it writes the collaborator row (`null` revokes; grants go through [Flow Invitation](#flow-invitation)'s idempotent `grantAccess` upsert), maps the [Flow Role](#flow-role) onto the room's Access vocabulary (`roleToAccess`), and pushes the change onto every live socket through `YjsServer.setAccess` ([ADR-0022](docs/adr/0022-flow-role-transition-has-one-owner.md)). Every role mutation routes through it — the collaborator procedures directly, the invitation grant via an injected `GrantRole` adapter — and `flow.delete` (`deleteFlow` in the [Flow library](#flow-library)) calls `dropRoom` (a join racing it is closed with 4404). The same pattern carries a rename: the flow row owns the name, and `flow.update` (`updateFlow` in the Flow library, via `mirrorNameToDocument` in `flow-rename.ts`) mirrors it into the document's `meta.name` through `YjsServer.writeMeta` (the live room if one is loaded, else a merge into the store), best-effort with background retries. Clients never write `meta.name` when they open a flow. Same-process only: `apps/server` mounts the tRPC router and the websocket endpoint together, so both hold the one `yjsServer` singleton ([ADR-0015](docs/adr/0015-room-connection-owns-access.md)).

## Flow library

The one module that owns a cloud flow's row and its two Yjs documents — `packages/api/src/routers/flow-library.ts` ([ADR-0034](docs/adr/0034-database-handle-bound-at-the-composition-root.md)). `ydoc` is the document collaborators edit (the live room holds the current copy while one is loaded); `publishedYdoc` is the snapshot the Community sees. Everything that creates (`createFlow`, `forkCommunityFlow`), reads (`openFlow`, `listFlows`), renames (`updateFlow`), deletes (`deleteFlow`), publishes (`publishFlow`, `unpublishFlow`), lists, bookmarks or forks a flow goes through it, so those rules are stated once: a flow starts from content (nothing, imported nodes and edges, or a snapshot) built the same way; readers take the live room ahead of the stored row; people shown next to a flow carry their [Collab identity](#collab-identity). It does not decide who may call it: the routers (`flow.ts`, `community.ts`) validate input, run the [Flow Access seam](#flow-access-seam) and make one call. What it cannot find it reports as `FlowLibraryNotFound`. The modules under the routers know nothing of tRPC; one middleware on the base procedure (`codeOf`, `packages/api/src/index.ts`) gives `FlowAccessDenied`, `FlowLibraryNotFound` and `CannotInviteSelf` their codes (`FORBIDDEN` / `NOT_FOUND`, `NOT_FOUND`, `BAD_REQUEST`) and keeps the module's message.

## Community flow

A flow whose `publishedAt` is set. The Community shows its `publishedYdoc`, the snapshot `publishFlow` froze, never the author's live document: later edits stay private until the next publish, and unpublishing clears both columns while bookmarks and forks stay. Popularity is its bookmark count (`flow_bookmark`, at most one per user and flow); its fork count derives from the flows whose `forkedFromId` names it. A fork (`forkCommunityFlow`) copies the snapshot into a new flow the caller owns. Browsing, a single flow and a maker's profile are public tRPC procedures (`community.ts`); bookmarking and forking into an account need a session. Rules in the [Flow library](#flow-library).

## Collab identity

The colour and icon a user appears with next to a flow and in a room: `{ collabColor, collabIcon }` from their `user_settings` row. `collabIdentity(settings)` (`packages/api/src/routers/flow-library.ts`) is the one reader; it falls back to `DEFAULT_COLLAB_IDENTITY` (`packages/db/src/schema/user-settings.ts`, also the column defaults) for a user who never chose one or has no settings row yet.

## Room Connection

The handle `YjsServer.join(flowId, socket, userId, canWrite)` hands back, in `packages/collab/src/yjs-server.ts` — `{ flowId, userId, canWrite, receive, close }`. The only way to reach a room: bytes go in through `receive`, the attachment ends with `close`. A transport cannot address a room by id plus a socket it claims to own, so the room always recognises the sender and its access decision. The handle also owns the awareness client ids seen on that socket, which `close` clears.

**Access** is the room's own vocabulary for what a user may do — `"none" | "read" | "write"` — deliberately not [Flow Role](#flow-role): the collab package knows about reading and writing, not owners and collaborators, and the caller maps between them. `setAccess(flowId, userId, access)` applies a change to every live connection that user holds and tells each client ([Live access](#live-access)); `"none"` closes their sockets with the terminal code 4401.

**Close codes** are sorted by what the client should do (`classifyClose`, `packages/collab/src/protocol.ts`): 4400–4499 is terminal (4401 access revoked, 4403 forbidden, 4404 flow gone); 1008 means re-authenticate, with a few bounded retries; everything else, including 1011 (the server could not decide or load) and 1012 (server restarting), is retried. The websocket gate's decision lives in `apps/server/src/room-gate.ts`.

Presence is client-authored, so the room rewrites `user.id` on every inbound awareness state to the authenticated user behind the connection before applying it — otherwise a Viewer can present themselves as the Owner in cursors and the collaborator panel.

## RoomStore

The persistence seam under a Yjs room: `{ load(flowId), save(flowId, state) }` in `packages/collab/src/room-store.ts`. `YjsServer` owns rooms and awareness, and composes one `RoomPersistence` per room for the save policy; where the document lives sits behind this interface. `save` **merges** into the stored state and never replaces it (`mergeDocumentStates`), so saves from two server instances converge whatever order they land in. Two adapters: `drizzleRoomStore` (`flow.ydoc`, merged under a row lock; the only file in the package that imports the database) and `MemoryRoomStore` (records every `save`, so room lifecycle and durability are testable without one). `handler.ts` is the composition root that pairs the singleton server with the production adapter.

## Db handle

The seam between the server-side packages and Postgres: `Db`, a drizzle handle over the Microflow schema (`packages/db/src/index.ts`, [ADR-0034](docs/adr/0034-database-handle-bound-at-the-composition-root.md)). A process gets its database from its composition root, once, through `bindDb(handle)`; a second bind throws. The exported `db` is a read-only view that forwards to the bound handle, so modules may import and hold it before the root runs, and an unbound process fails on its first query instead of reading `DATABASE_URL` for itself. Two adapters:

- **Production** — `createDb(connectionString)`, a node-postgres pool. `apps/server/src/database.ts` binds it, imported first by `apps/server/src/index.ts`.
- **In-process Postgres** — `@microflow/db/testing` (`packages/db/src/testing.ts`): PGlite with the real migrations applied, bound when the module is imported. `useTestDb()` empties every table and returns the handle; tests call it before each test. It is one connection, so inside a `db.transaction()` callback only the `tx` may query.

## Settled room

A room whose every accepted change is in the [RoomStore](#roomstore), with no save in flight (`RoomPersistence.isSettled`, `packages/collab/src/room-persistence.ts`). Only a settled room is acknowledged to clients as saved, and only a settled room is destroyed when its last connection leaves. An unsettled room stays in memory, retrying its save with backoff (1 s doubling to 30 s, without giving up), and is handed to the next join. Changes are noticed from the document's own `update` event, never from the sync message type. Readers that serve a flow (the [Flow library](#flow-library), behind `flow.get`, `flow.list` and `flow.publish`) read `YjsServer.currentState()` ahead of the stored row.

## Room drain

What the server does on SIGTERM before it exits: `YjsServer.shutdown` refuses new joins, closes every socket with 1012 (clients reconnect to the next instance), and saves rooms until all are [settled](#settled-room) or 8 s pass (`apps/server/src/shutdown.ts`). The process exits non-zero when a room could not be saved, so the loss shows in the orchestrator's log.

## Flow Invitation

The invite → accept → revoke lifecycle for a cloud flow, in `packages/db/src/flow-invitation.ts`. `inviteByEmail` grants immediately when the address has an account — through an injected **GrantRole** adapter, which the api layer satisfies with `setFlowRole` so the grant reaches live sockets too ([ADR-0022](docs/adr/0022-flow-role-transition-has-one-owner.md)) — and records a `flowInvite` row otherwise; `acceptInvites(email, userId)` converts pending invites on sign-up in one transaction: a `DELETE … RETURNING` consumes them and exactly those rows are granted, so a failure leaves every invite pending. It is deliberately rows-only, since a user who just created their account holds no live socket. Every grant (`grantAccess`, and the accept path beside it) is one upsert on the `(flow_id, user_id)` unique index, so every grant path is idempotent and no path needs a check-then-insert. Inviting your own address is refused with `CannotInviteSelf`. `listPendingInvites` / `revokeInvite` make pending invites visible in flow settings.

Lives in `@microflow/db` because it is the only package both callers can reach — the flow router (`@microflow/api`) invites and the better-auth `user.create.after` hook (`@microflow/auth`) accepts, and api already depends on auth ([ADR-0016](docs/adr/0016-flow-invitation-module.md)). Email (**InviteMailer** — `resendInviteMailer` in production, a recording function in tests) and the grant (**GrantRole**) are injected as adapters, so the module needs neither mail nor collab; a failed notification never undoes a grant.

## Failure surface

What a user sees when something fails, together with the report we receive about it. Errors reach it through one module, `reportError` (`apps/web/src/lib/report-error.ts`), from error boundaries, the router's `defaultOnCatch`, the global `error` and `unhandledrejection` handlers, failed user actions, a local store that will not open, and desktop runtime crashes. The screens (`apps/web/src/shell/failure-screens.tsx`: the route error screen, the full-screen root variant, not-found) show the error's reference and never touch the flow document ([ADR-0029](docs/adr/0029-one-failure-surface.md)).

## Error report

The record of one failure that may leave the device: a fingerprint (a hash of the error's class and code locations), the class name, where it was caught (`source`) and the route id pattern. Never the message or the stack text, which can carry flow content, config values or tokens.

## Error sink

An adapter that receives [Error reports](#error-report). A remote `ErrorSink` (the Umami `app_error` event today) gets only the frozen report, throttled per fingerprint; a `LocalErrorSink` (the console) also gets the raw error and stays on the device. A crash reporter is one more remote sink passed to `configureErrorReporting`.

## Browser smoke suite

Four end-to-end flows that prove the built web app works in a real browser engine: it boots without errors, a node added to the local flow survives a reload, a template loads, and an unknown URL shows the not-found screen. Playwright Test over `playwright-core`, against `vite preview` with no server (`apps/web/e2e/*.smoke.ts`, `bun run smoke`). It never launches a browser; it attaches over CDP to Obscura, locally and on CI. A flow fails on any uncaught page error or `[report-error]` console line, and every third-party request is aborted. Runs nightly and gates every release (`.github/workflows/smoke.yml`).

## Live smoke suite

The post-rollout check against the deployed site (`bun run smoke:live`, `apps/web/playwright.live.config.ts`). It runs the browser smoke flows tagged `@live` against microflow.tech, with the deployed server reachable, plus read-only server checks in `apps/web/e2e/*.live.ts`: the server answers, auth returns a signed-out session, CORS allows the web origin and both desktop webview origins, the supporters list loads, the room gate closes a signed-out socket with 1008, and the docs site is up. Nothing in it signs in or writes to the database. `SMOKE_BASE_URL`, `SMOKE_SERVER_URL` and `SMOKE_DOCS_URL` point it elsewhere. Runs on demand and daily (`.github/workflows/smoke-live.yml`).

## Hardware smoke suite

The desktop runtime against a real board (`bun run smoke:hardware`, `apps/web/src-tauri/src/runtime/hardware_smoke.rs`). It needs an Arduino with StandardFirmata on USB (`MICROFLOW_HW_PORT`, or the first Arduino-like port), so its tests are `#[ignore]`d and run only locally. It runs the real path: USB identification, Firmata detection, then the runtime actor on the open port. It checks the result with the board's own pin-state query: a Led flow drives pin 13, exit leaves the board at the safe state, a board reset mid-session restores the LED, A0 readings reach a Sensor node, and a second session reconnects.

- **Flash check** — opt-in, and first in the suite (`apps/web/src-tauri/src/flasher/hardware_smoke.rs`). With both `MICROFLOW_HW_PORT` and `MICROFLOW_HW_FLASH=<board id>` set (`uno`, `nano`, `nanoNew`, `mega`, `leonardo`, `micro`) it flashes StandardFirmata through the desktop [Flash executor](#flash-executor) and then asks the board for Firmata. It overwrites firmware, so it never picks a port or a board itself. One board per protocol covers the [Flash drivers](#flash-driver).
