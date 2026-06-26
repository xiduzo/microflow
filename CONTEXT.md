# Context — Domain Language

Living glossary. Keep aligned with code. Update when terms shift.

## Component Catalog

The single source of truth for every flow component the UI exposes and the runtime executes. Lives at `apps/web/node-components.json`. Has two arrays:

- **`entries`** — UI-visible component names. Each row is one item the user can drop on the canvas. The `name` is also the value of `data.instance` in Yjs / ReactFlow. Variants (e.g. `Potentiometer`) are entries that point at another impl.
- **`impls`** — the runtime classes the Rust runtime knows how to construct. Each row carries `category` (Rust module path) and `requiresHardware` (whether `BoardHandle::initialize` is called).

### Fields

| Field                      | Where           | Meaning                                                                                                |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `entries[].name`           | UI + Yjs        | Instance string used as ReactFlow node type and `data.instance`.                                       |
| `entries[].impl`           | runtime mapping | The `impls` row this entry resolves to. May be the entry's own name, or a parent impl for variants.    |
| `impls[].name`             | Rust            | The Rust struct name (also derives `<Name>Config`).                                                    |
| `impls[].category`         | Rust            | Module path under `runtime/`: `input`, `output`, `control`, `transformation`, `generator`, `external`. |
| `impls[].requiresHardware` | Rust            | If true, registry calls `Component::initialize(board)` when board connected.                           |
| `<Impl>::ports()` / `emits()` | Rust (source)   | The declared **Port** / **Emit** sets — the single source of truth. **No longer catalog fields**: generated from the Rust consts into `wire-interface.generated.json`, thence `COMPONENT_PORTS`/`COMPONENT_EMITS` + `PortOf<T>`/`EmitOf<T>`. See § Port / § Emit / § Generation. |

### Generation

The catalog drives the frontend; the **wire interface flows the other way**, from Rust:

- `apps/web/scripts/codegen-node-registry.ts` reads `entries` (+ `impls[].usesHostAdapter`) from the catalog **and** the Port/Emit sets from `apps/web/wire-interface.generated.json`, then writes `apps/web/src/components/flow/nodes/_REGISTRY.ts` and `_base/_base.types.ts`. Run via `bun run codegen` in `apps/web`.
- `apps/web/wire-interface.generated.json` is generated **from Rust** `<Impl>::ports()`/`emits()` by the **Catalog Parity Guard** (`apps/web/src-tauri/tests/catalog_parity.rs`) when run with `BLESS_WIRE_INTERFACE=1`; otherwise the same guard asserts the committed file is current, so a stale mirror fails CI rather than shipping wrong handle types. `bun run catalog:sync` (in `apps/web`) blesses + re-codegens in one step. Port/Emit thus have **one** source — the compile-checked Rust consts — and no hand-authored catalog mirror to drift.
- `apps/web/src-tauri/build.rs` no longer generates anything (it is just `tauri_build::build()`). The old `register_all_body.rs` codegen and its port-drift assertion were dropped in the re-host ([ADR-0006](docs/adr/0006-rehost-runtime-on-core.md)); the `ComponentRegistry` now hand-registers nodes in `register_all` (`crates/microflow-core/src/runtime/registry.rs`).

## Component Registry

The Rust-side runtime view of the Component Catalog. Holds factory closures keyed by `entries[].name`. Built once at runtime construction; queried by `FlowRuntime::update_flow` to instantiate `Box<dyn Component>` per flow node.

## Variant

An `entries` row whose `impl` differs from its `name`. Reuses the parent impl's runtime behavior and TS schema. Examples: `Potentiometer`/`Force`/`Ldr`/`HallEffect`/`Tilt` over `Sensor`; `Vibration` over `Led`. Variants may override TS defaults (label, group, icon, subType) but cannot change runtime behavior — their factory delegates to the parent impl class.

## Category

A Rust module path under `runtime/`. Determines `use super::<category>::{<Impl>, <Impl>Config};` in generated registry. Distinct from TS-side `defaults.group` (which is a freeform UI grouping label).

## Component (Rust trait)

In `crates/microflow-core/src/runtime/component.rs`. The interface every impl satisfies. Decision and migration captured in `docs/adr/0001-component-trait-flow-separation.md` (see also `docs/RUNTIME_AUDIT_APRIL_2026.md` §3.5 / §3.3). Three distinct flows enter the trait, each with its own method:

- **Port** — edge inputs. Delivered via `dispatch(&str, ComponentValue)`. Each impl declares its accepted Port set via `fn ports() -> &'static [&'static str] where Self: Sized`.
- **Internal Event** — self-routed methods. Delivered via `dispatch_internal(&str, ComponentValue)`.
- **Hardware Callback** — board-reader-driven events. Delivered via `HardwareComponent::on_pin_change` / `on_i2c_reply`.

The shared underscore-prefix routing in `runtime/mod.rs::process_event` dispatches to the right method based on the reserved handle name; everything else is a Port.

## Port

A named edge-input slot on a **Component (Rust trait)**, delivered as `target_handle` from a flow edge into `Component::dispatch`. Each impl declares its closed Port set via `fn ports() -> &'static [&'static str]`. The set is the **single source of truth** for the wire interface: the live **Catalog Parity Guard** ([ADR-0007](docs/adr/0007-node-wire-interface-emit-contract.md)) generates it — ports **and** Emits — from the Rust consts into `wire-interface.generated.json` (the successor to the `build.rs` port codegen dropped in the re-host, [ADR-0006](docs/adr/0006-rehost-runtime-on-core.md)). The frontend codegen (`apps/web/scripts/codegen-node-registry.ts`) reads that file to emit `COMPONENT_PORTS` (a typed const object) and `PortOf<T>` (a literal-union helper) into `_base/_base.types.ts`, so ReactFlow target handles are type-checked against the same Rust source. Empty array for components with no edge inputs (e.g. `Constant`).

Examples: `Led` accepts `"true"/"false"/"toggle"/"value"`; `Stepper` accepts `"value"/"to"/"stop"/"zero"/"enable"`; `Button` accepts `"read"` (and receives the digital-pin Hardware Callback separately via `on_pin_change`).

Distinct from **Emit** names (edge *outputs*), **Internal Event** names (never on edges, self-routed only), and **Hardware Callback** names (never on edges, runtime-delivered only).

## Emit

A named edge-**output** slot on a **Component (Rust trait)** — the `source_handle` a component emits on, delivered to the **FlowRouter** for fanout. The symmetric counterpart of **Port**. Each impl declares its closed Emit set via `fn emits() -> &'static [&'static str]` — the single source — generated from Rust into `wire-interface.generated.json` and thence to the frontend as `COMPONENT_EMITS` / `EmitOf<T>` (so React source `<Handle id=…>` ids are type-checked against the same Rust source). Decision in [ADR-0007](docs/adr/0007-node-wire-interface-emit-contract.md).

Emit handles are compile-checked on the Rust side: each impl declares its handles as associated `const`s (e.g. `Button::E_EVENT`) referenced at every emit site **and** in `emits()`; a mistyped emit does not compile. The implicit `"value"` emit — fired by `ComponentBase::set_value` whenever the value changes — is centralized as `ComponentBase::VALUE_HANDLE` and listed in `emits()` by every value-emitting node. Examples: `Button` emits `"event"/"true"/"false"/"hold"/"value"`; `Compare`/`Gate` emit `"true"/"false"/"value"`; `Llm` emits `"thinking"/"value"/"done"/"error"`; value-only sinks emit just `"value"`.

Excludes `_`-prefixed **Internal Event** / wakeup names (e.g. `_hold`, `_tick`) — those are self-routed and never appear on an edge. The **Catalog Parity Guard** (`apps/web/src-tauri/tests/catalog_parity.rs`) generates `emits()` into `wire-interface.generated.json` and asserts the committed file is current.

## Internal Event

Self-routed method delivered when a **Component (Rust trait)** emits a `ComponentEvent` whose `source_handle` starts with `_` and is not a reserved **Hardware Callback** name. The executor (`runtime/mod.rs::process_event`) strips the leading `_` and calls `Component::dispatch_internal` on the source component. Used by components that schedule their own state transitions (e.g. `Piezo` `auto_stop` after a song-playback thread finishes). Never observable as a **Port** — edges cannot target an internal-event name.

## Hardware Callback

Board-reader-driven event delivered to a **HardwareComponent** in response to Firmata wire activity. Two live kinds today, routed by `runtime/mod.rs::process_event` to typed methods on `HardwareComponent`:

- `_pin_change` (from the **Board IO Loop**'s `PinChangeCallback`) → `on_pin_change(value)`. `value` is `Bool` for digital pins, `Number(u16)` for analog.
- `_i2c_reply` (from `I2cReplyCallback`) → `on_i2c_reply(value)`. `value` is `Array` of byte values.

Emission of these reserved handles is the runtime's responsibility (in `FlowRuntime::install_pin_change_callback` / `install_i2c_reply_callback`); no flow edge may emit them. The two handle names plus the `_` prefix are centralized as consts in `runtime/mod.rs`'s `reserved_handles` module — referenced at each emit and `dispatch_internal_event` match site rather than written as bare string literals. A third reserved name `"stepper_reply"` is referenced in `Stepper::call_method` and the module docstring but has no current emission path — a forward-looking placeholder pending stepper sysex wiring, intentionally left out of `reserved_handles` until it routes anywhere.

## FlowRouter

The seam that turns one outgoing `ComponentEvent` into the list of `DispatchCall`s the executor invokes. Lives in `crates/microflow-core/src/runtime/router.rs`. Owns the (source, source_handle) → target index (`EdgeMap` backed by `FxHasher` over both strings with a 0-byte separator) and the per-target delivery decision; nothing else in `FlowExecutor` knows the edge layout.

Two delivery shapes today, chosen per target via `ComponentLookup::aggregates(target_id)`:

- **Direct** — pass `event.value` (cloned once) through to one target. The default for non-aggregating targets.
- **Snapshot** — collect every source feeding the same `(target_id, target_handle)` via `ComponentLookup::value_of(source)` and wrap as `ComponentValue::Array`. Chosen for targets that return `Component::aggregates_inputs() == true` (today `Calculate`, `Gate`). The just-emitted source must already have been `set_value`'d by the executor's echo step, or snapshot reads a stale value for it — see `runtime/mod.rs::process_event`.

`ComponentLookup` is a 2-method trait (`aggregates`, `value_of`) the executor satisfies with a thin `ComponentMapLookup` adapter over its `HashMap<String, Box<dyn Component>>`. The router has no opinion about how components are stored; router tests pass a `HashMap<String, (bool, ComponentValue)>` mock and never instantiate real Components.

Internal Events and Hardware Callbacks never reach `FlowRouter` — source == target by construction, dispatched straight from `executor::process_event`. Stale-sequence gating also happens upstream of `route()`. Decision and migration captured in `docs/adr/0002-flow-router-seam.md`.

## Sans-IO Runtime

The Live Flow Runtime is **sans-IO**: a node never touches the serial port, a clock, or a timer. The engine lives in `crates/microflow-core/src/runtime/` (gated behind the `runtime` cargo feature) and is driven by a **Runtime Host** per platform. Decision and migration captured in [ADR-0006](docs/adr/0006-rehost-runtime-on-core.md). During one `dispatch` / `on_pin_change` / `wake`, a **Component** is handed a [`RuntimeContext`](#runtimecontext); when the turn drains, the runtime returns one [`Effects`](#effects) record the host applies. Replaces the desktop `BoardHandle` + **Board IO Loop** + `CommandReceipt` stack described by ADR-0001/0002 — all deleted in the re-host.

## RuntimeContext

The per-dispatch capability context. Lives in `crates/microflow-core/src/runtime/context.rs`. Exposes exactly three host capabilities to a node for the duration of one call: a [`BoardWriter`](#boardwriter) (`ctx.board()` — encodes Firmata bytes into the turn's outbound buffer), the host clock (`ctx.now_ms()`), and the wakeup scheduler (`ctx.schedule_wakeup(method, delay_ms)` / `ctx.cancel_wakeup(method)`). The node id is implicit, so scheduling targets the caller. A node cannot block, sleep, or read a wire — those are the host's job, recorded as [`Effects`](#effects).

## Effects

The side-effect record the host executes after one runtime turn. Lives in `crates/microflow-core/src/runtime/context.rs`. `Effects { outbound_bytes: Vec<u8>, component_events: Vec<ComponentEvent>, wakeups: Vec<Wakeup>, cancellations: Vec<WakeupId> }`. Every `FlowRuntime` entry point (`update_flow`, `feed_bytes`, `wake`, `dispatch`, `deliver_message`, `inject_event`, `dispatch_key_event`) returns one `Effects`. The **Runtime Host** writes `outbound_bytes` to the port, dispatches `component_events` to its UI stores, arms each [`Wakeup`](#wakeup) as a timer, and clears `cancellations`. Nothing crosses the wire until the host applies the effects — which is what makes the runtime testable without hardware or a host (feed input, assert on the returned `Effects`). *How* a host applies the four fields — their order — is not the host's choice: it is fixed by [`Effects::apply`](#effectssink) ([ADR-0008](docs/adr/0008-effects-apply-policy.md)).

## EffectsSink

The typed per-field hook surface a [Runtime Host](#runtime-host) implements to apply one turn's [`Effects`](#effects); the **apply policy** that drives it lives in core, once. `Effects::apply(&self, sink: &mut impl EffectsSink)` (`crates/microflow-core/src/runtime/context.rs`) iterates the fields in the **canonical order** — `outbound_bytes → cancellations → wakeups → cloud_requests → component_events` — calling one hook each: `write_bytes`, `cancel_wakeup`, `arm_wakeup`, `perform_cloud`, `dispatch_event`. Bytes first (wire latency); cancel-before-arm (so a cancel + re-arm of the same logical timer in one turn is safe); cloud calls launched before UI events leave; UI events last (they leave the runtime and do not feed back this turn). Decided in [ADR-0008](docs/adr/0008-effects-apply-policy.md) after the two hosts' inline apply loops had already drifted in order. The platform *primitives* behind each hook stay per-host (desktop: serial flush + Tauri `emit` + Tokio timer; browser: `connection.write` + store ingest + `setTimeout`). The desktop `Actor` calls `Effects::apply` directly; the browser reactor cannot reach into Rust, so it mirrors the same shape in `apps/web/src/lib/firmata/effects-sink.ts` (`applyEffects` + an `EffectsSink` interface `FlowReactor` implements). The mirror is held **structurally**, not by a test alone: `applyEffects` drives an `EFFECT_HANDLERS` map and an `APPLY_ORDER` tuple, both typed exhaustive over `keyof Effects`, so a new `Effects` field is a TypeScript compile error (unhandled / unordered) on the browser side just as it is a missing trait method on every Rust sink — the conformance test (`context::apply_tests` / `__tests__/effects-sink.test.ts`) now asserts the runtime *order*, no longer carrying the coverage guarantee alone. Adding an `Effects` field thus forces a hook in core's trait **and** in the browser handlers (exactly how ADR-0009's `cloud_requests` field forced `perform_cloud`, for [`CloudRequest`](#cloudrequest)s, into the order).

## BoardWriter

The sans-IO Firmata write surface used by hardware **Component**s. A trait in `crates/microflow-core/src/runtime/board.rs` with typed methods (`set_pin_mode`, `digital_write`, `analog_write`, `enable_analog_reporting`, `shift_out`, `tone`, `sysex`, the I2C ops, …), each encoding one or a few Firmata messages — none block or do I/O. The production adapter `BufferBoardWriter` encodes into the turn's outbound `Vec<u8>` via the shared `FirmataClient` codec; it is built fresh per turn, borrowing the runtime's codec (for the pin table) and the buffer. One-to-one with the deleted desktop `BoardConnection` encode bodies, minus all I/O. Tests assert on `Effects.outbound_bytes` directly — the old `Arc<BoardHandle>` / `BoardCommand` / `CommandReceipt` / `TestIoLoop` / `MockBoardHandle` stack is gone.

## Wakeup

A future self-callback a timer node asked for, replacing `std::thread::sleep`. Lives in `crates/microflow-core/src/runtime/context.rs`. `Wakeup { id: WakeupId, node_id, method, delay_ms }`. A node calls `ctx.schedule_wakeup(method, delay_ms)`; the runtime resolves the request against its outstanding-wakeup table and surfaces it as `Effects.wakeups` (with `Effects.cancellations: Vec<WakeupId>` for cancelled ones). The **Runtime Host** owns the actual timer and calls `FlowRuntime::wake(node_id, method)` when it fires, which routes `dispatch_internal(method, …)` back to the node. Used by `Interval`, `Delay`, `Piezo` song playback, and other timer nodes.

## Runtime Host

The platform adapter that drives a `core::FlowRuntime` and applies its [`Effects`](#effects). Two real adapters make the `Effects` a real seam ([ADR-0006](docs/adr/0006-rehost-runtime-on-core.md)):

- **Desktop** — `apps/web/src-tauri/src/runtime/host.rs`. A `!Send` `FlowRuntime` lives inside a dedicated actor thread (`run_actor`) that owns the serial port and a Tokio handle (timers, cloud I/O). Only `Send` handles cross the spawn boundary; cloud-node results (LLM / MQTT / Figma) re-enter the runtime via `inject_event` through a `ChannelEmitter`. The desktop's previous duplicate runtime was deleted in the re-host.
- **Browser** — `apps/web/src/lib/firmata/flow-reactor.ts`. A `setTimeout` / Web-Serial loop driving the `microflow-runtime-wasm` engine: writes `outbound_bytes` to the port, fans `component_events` to the Zustand stores, maps `wakeups` to `setTimeout` and `cancellations` to `clearTimeout`. A shallow pass-through — all depth lives behind the wasm seam in Rust.

## Wiring

Per-impl description of how a constructed **Component** attaches to its execution environment. Returned as plain data from the trait (or sibling `ExternalSubscriber` trait); the runtime reads and applies it without naming any specific component.

Replaces the instance-name `match` blocks formerly in `runtime/mod.rs::register_component_pin_listener` and `runtime/commands.rs::extract_*`. Wiring is **descriptive, not active** — components return data, runtime acts. Lets a component's wiring be tested as a value, no `&mut self`, no sinks.

Two kinds:

- **Listener Wiring** — sync, in-process. Pin (digital, or analog with threshold), I2C address, hotkey accelerator. Returned from `Component::listener_wiring()` as `Vec<ListenerWiring>`.
- **Subscriber Wiring** — async, broker-dependent. MQTT topic + handler kind. Returned from `ExternalSubscriber::subscriber_wiring()` (only impl'd by components that need brokers, e.g. `Mqtt`, `Figma`).

Distinct from the **Component Catalog**: catalog is metadata for _registration_ (what UI shows, how to construct); Wiring is per-impl _behavior_ applied after construction.

## Runtime Services

> ⚠ **Reconciled (2026-06 · post-re-host).** ADR-0002 Phase 4 designed a
> `RuntimeServices` bundle + `ComponentBuilder::Deps: FromServices` threaded
> through construction. The re-host ([ADR-0006](docs/adr/0006-rehost-runtime-on-core.md))
> **superseded that mechanism** to keep `tokio`/`reqwest`/`rumqttc` out of
> `microflow-core`. It does not exist in the current code; the description below
> is the actual state.

The **Capability Trait**s and **Service Registry**s (`LlmRegistry`,
`MqttPublisher`, `LlmProvider`, …) live in the **desktop** crate
(`apps/web/src-tauri/src/runtime/services/`), not in core — core stays
dependency-light. They are **not** threaded through a `RuntimeServices` bundle or
a `Deps` associated type. Core's `ComponentBuilder` is `{ type Config; fn
build(id, config) }` (`runtime/component.rs:226`) — no services. As of
[ADR-0009](docs/adr/0009-cloud-sans-io-capability.md) the cloud nodes no longer
capture services either: they are sans-IO and emit [`CloudRequest`](#cloudrequest)s
the host performs (see **Cloud Node Registration** below). The live
`MqttPublisher` / `LlmRegistry` now live on the desktop host's **CloudPerformer**
(behind the [`EffectsSink`](#effectssink) `perform_cloud` hook), not on the nodes.

## CloudRequest

An outbound cloud call a node asks the host to perform, recorded as the
[`Effects`](#effects) field `cloud_requests` (the sans-IO replacement for the old
in-component `tokio::spawn`). Lives in `crates/microflow-core/src/runtime/context.rs`.
`CloudRequest { source: Arc<str>, kind: CloudRequestKind }`; `CloudRequestKind` is
`MqttPublish { broker_id, topic, payload, retain }` (fire-and-forget) or
`LlmGenerate { provider_id, model, system, prompt }` (result re-enters). A cloud
node's `dispatch` calls `ctx.request_cloud(kind)` instead of touching the network;
the host's [`EffectsSink`](#effectssink) `perform_cloud` hook performs it, and any
result re-enters via `FlowRuntime::inject_event` keyed on `source`. The node thus
holds no Tokio/`reqwest`/`rumqttc` and is unit-tested by asserting the recorded
request (`cloud::test_support::recorded_cloud_requests`). Decided in
[ADR-0009](docs/adr/0009-cloud-sans-io-capability.md); on the desktop the I/O is
performed by the **CloudPerformer** (a deep module on the actor holding the live
services + the latest-wins LLM task table). Phase 3 added the browser performer:
`FlowReactor.performCloud` does `LlmGenerate` directly via `fetch` (mirroring the
desktop `HttpLlmProvider`, with latest-wins `AbortController` cancellation) and
re-enters the result through the wasm `injectEvent` binding. `MqttPublish`
(MQTT + Figma) publishes over WSS via `mqtt.js`; inbound subscribe routing comes
back through the wasm `deliverMessage` binding. The desired subscription set is
reconciled by core's **`reconcile_desired`** (the shared winner-selection policy:
collapse to one sub per `(broker, topic)`, routing kinds beat display-echo, ties
break on the lower node id — `crates/microflow-core/src/runtime/subscriptions.rs`)
via the wasm `reconcileSubscriptions()` binding on each `applyFlow`; each host then
diffs that set against its own live subscriptions and owns its broker I/O. The
same `reconcile_desired` feeds the desktop `flow_update`, so both hosts pick the
identical owner per topic instead of mirroring the policy in two languages.

## Cloud Node Registration

Cloud nodes are no longer special-cased. Because they are sans-IO (ADR-0009),
the `Mqtt`/`Llm`/`Figma` nodes live in `microflow-core`
(`runtime/cloud/{mqtt,llm,figma}.rs` behind the `cloud` feature; their POD configs
in `config/{mqtt,llm,figma}.rs`, ungated) and register in
`registry.rs::register_all` via the same typed `register::<B>(name)` every
built-in uses — landing in `declared()`, so the **Catalog Parity Guard** reads
them uniformly. Both the desktop bin and the browser wasm build enable `cloud`,
so each gets the cloud nodes from this one place; the desktop's hand-written
factory closures and the `register_factory` / `register_node` / `register_cloud`
helpers are **deleted** (the host-injection machinery collapsed once cloud went
sans-IO). All that stays per-host is the [`EffectsSink`](#effectssink)
`perform_cloud`: the desktop **CloudPerformer** (`rumqttc`/`reqwest`) and the
browser `FlowReactor` (LLM via `fetch`; MQTT/Figma over WSS via `mqtt.js`, with a
per-broker connection manager in `lib/firmata/cloud/`).

## Capability Trait

A Rust trait describing one external kind's outbound operations (e.g. [`LlmProvider`](#llm-provider)`::generate`, `MqttPublisher::publish`). Lives in `runtime/services/<kind>.rs`. Components depend on `Arc<dyn CapabilityTrait>` (or on the **Service Registry** that maps id → `Arc<dyn CapabilityTrait>`), never on the concrete HTTP client / broker library.

Each Capability Trait ships with two adapters from day one — a production impl (e.g. `HttpLlmProvider`) and a recording test impl (e.g. `RecordingLlmProvider`) — which is what makes the trait a real seam rather than a hypothetical one (same rule as **BoardHandle** + **TestIoLoop**).

See [ADR-0002](docs/adr/0002-per-capability-service-traits.md).

## Service Registry

Live, mutable map of `id → Arc<dyn CapabilityTrait>` for one capability kind (e.g. `LlmRegistry`, future `MqttRegistry`). Lives in `runtime/services/<kind>.rs`. The frontend's authoritative list is pushed in full via `sync(providers: Vec<(id, Arc<dyn ..>)>)`; existing in-flight calls against the previous instance run to completion, subsequent lookups see the new entry.

Components hold `Arc<Registry>` and resolve the **Capability Trait** by id at dispatch time, not at construction time. Consequence: credential / endpoint rotation takes effect on the next call, no component rebuild, no flow_update re-fire.

Replaces the parallel `LlmManager` + `RuntimeContext.providers` dual-state pattern.

## LLM Provider

The **Capability Trait** for any backend that can run an LLM completion against an OpenAI-compatible `/v1/chat/completions` request shape. Lives in `runtime/services/llm.rs`. Carries one method:

```rust
async fn generate(&self, request: LlmRequest) -> Result<LlmResponse, LlmError>;
```

`LlmRequest` is `{ model, system: Option<String>, prompt }` — template substitution is the caller's job, the provider sees the rendered text. `LlmResponse` is `{ text }` for now; token counts / finish reasons accrete only when a consumer needs them.

Production adapter: `HttpLlmProvider` (one `reqwest::Client` per instance for connection-pool reuse; empty `api_key` skips the `Authorization` header so local Ollama works). Test adapter: `RecordingLlmProvider` (records every request, returns scripted responses or errors from a FIFO queue, returns `LlmError::Cancelled` when the script is exhausted).

## MQTT Publisher

The **Capability Trait** for any backend that can publish a single MQTT message. Lives in `runtime/services/mqtt.rs`. One method:

```rust
async fn publish(&self, broker_id: &str, topic: &str, payload: &[u8], retain: bool) -> Result<(), MqttPublishError>;
```

`MqttPublishError::BrokerNotConnected` is distinguished from `PublishFailed` so callers (UI, logs) can prompt for a reconnect instead of surfacing a generic wire error.

Production adapter: `crate::mqtt::manager::MqttManager` (via `impl MqttPublisher for MqttManager` in `runtime/services/mqtt.rs`) — delegates to the existing broker pool, translating the legacy `String` error into the typed variant. Test adapter: `RecordingMqttPublisher` (records every `(broker_id, topic, payload, retain)` tuple and pops scripted errors from a FIFO queue).

`Mqtt` and `Figma` components hold `Arc<dyn MqttPublisher>` and call `publish(...)` directly from their `dispatch` arms via a Tokio-spawned task. Replaces the legacy `_mqtt_publish` reserved-event pattern (component emits a JSON-encoded publish request, `lib.rs` parses it and re-routes through a dedicated handler thread) — that path was retired in [ADR-0002](docs/adr/0002-per-capability-service-traits.md) Phase 3.

## Host Adapter

Frontend mirror of **Wiring**. Each node component module may export an `adapter: NodeHostAdapter` (see `apps/web/src/components/flow/nodes/_base/host-adapter.ts`) describing what the host store + global hotkey listener need from this node:

- `prepareData(node, hosts)` — partial `data` patch to merge before sync (e.g. `Figma` injects `uniqueId` from `useFigmaStore`).
- `brokerIds(node)` — broker IDs this node depends on; collected and forwarded to the runtime.
- `accelerator(node)` — keyboard accelerator this node listens to; registered with `useHotkeys`.

The catalog `impls[].usesHostAdapter` flag drives codegen: when `true`, `_REGISTRY.ts` imports the entry's `adapter` export. The frontend registry exposes `adapter` on every entry (undefined when no adapter is needed), so consumers walk it without pattern-matching `data.instance`.

## FlowSession

Live editing context wrapping a **FlowDocument** plus a **SyncAdapter**. Lives in `apps/web/src/session/flow-session.ts`. A plain object: `{ flowId, mode, readOnly, doc, sync, destroy }`. Held by a **FlowSessionProvider** (one per route layout) and retrieved by `useFlowSession()` — which throws if called outside a provider, so consumers get type-narrowed access (`FlowSession`, never `FlowSession | null`) inside the subtree. Three factories: `createLocalSession()` pairs a fresh `FlowDocument` with a `LocalStorageSyncAdapter` (`readOnly: false`); `createCloudSession({ flowId, user, wsUrl, authToken, initialData? })` pairs a `FlowDocument` (seeded from `initialData` if provided) with a `WebSocketSyncAdapter` (`readOnly: false`); `createPreviewSession(nodes, edges)` pairs a fresh `FlowDocument` with a `NoOpSyncAdapter` for read-only thumbnail surfaces (`readOnly: true`). `destroy()` tears down the sync adapter, then the doc, in that order. The `readOnly` flag is consumed by `useNodeControls` to suppress the Leva→Yjs commit effect — without it, Leva's per-render `controlsData` identity churn would write to the preview doc on every render and (with no `ReactFlowBridge` to absorb the echo) loop.

## SyncAdapter

Base interface for the session's persistence/sync seam, mirroring the **Capability Trait** discipline on the Rust side ([ADR-0002](docs/adr/0002-per-capability-service-traits.md)). Lives in `apps/web/src/session/sync-adapter.ts`. Carries only `destroy()`. Two-tier: extended by `RemoteSyncAdapter` for server-backed adapters. `LocalStorageSyncAdapter` satisfies the base only — no `state`, no `users`, no `error`, because none of those are meaningful for localStorage. UI code switches on `session.mode === "cloud"` (or a `discriminator: "remote"` field on `session.sync`) to render the sync chip / collaborator panel.

## RemoteSyncAdapter

Sub-interface of **SyncAdapter** for server-backed adapters. Adds `state: SyncState`, `isSynced: boolean`, `users: AwarenessUser[]`, `localUser: AwarenessUser | null`, `error: Error | null`, `updateCursor`, `updateSelectedNodes`, `reconnect`, `disconnect`, and an `on(event, cb): () => void` subscription surface (events: `"state"`, `"awareness"`, `"error"`). Implemented by `WebSocketSyncAdapter` (production) and `RecordingSyncAdapter` (tests). Not implemented by `LocalStorageSyncAdapter`. The two-tier split is type-honest — local sessions don't lie about being "synced to nothing."

## LocalStorageSyncAdapter

The `SyncAdapter` for local-only flows. Lives in `apps/web/src/session/local-storage-sync-adapter.ts`. Subscribes to the `FlowDocument`'s Y.Doc updates and persists a snapshot to `localStorage` under `microflow-local-flow`. On construction, reads any existing snapshot and applies it to the doc. No `connect`/`disconnect` concept — the adapter is "always synced" with localStorage. `destroy()` flushes any pending write and removes the observer.

## WebSocketSyncAdapter

The production `RemoteSyncAdapter`. Lives in `apps/web/src/session/websocket-sync-adapter.ts`. Wraps the `SyncProvider` from [`@microflow/collab`](packages/collab/src/sync-provider.ts), forwarding `connect`/`disconnect`/`destroy`/`updateCursor`/`updateSelectedNodes` and translating `SyncProvider`'s `on(event, cb)` event names. If the constructor receives `initialData: Uint8Array` (typically a Yjs snapshot fetched via tRPC `flow.get`), it applies the snapshot to the doc synchronously before opening the WebSocket — eliminating blank-canvas during the sync handshake. `isSynced` flips true only after the Yjs `messageYjsSyncStep2` handshake completes, so UI gating on `isSynced` guarantees "latest state."

## RecordingSyncAdapter

Test-mode replacement for `WebSocketSyncAdapter`. Lives in `apps/web/src/session/recording-sync-adapter.ts`. Mirrors the [`TestIoLoop`](#testioloop) / `RecordingLlmProvider` ([ADR-0002](docs/adr/0002-per-capability-service-traits.md)) discipline. Records `appliedUpdates: Uint8Array[]`, `awarenessUpdates: AwarenessUpdate[]`, `connectCalls`, `disconnectCalls`, `destroyed`. Scripts `injectRemoteUpdate(update)` (simulate a collaborator's edit), `injectAwareness(users)` (simulate presence), `injectState(state)` (simulate connection drop / recover), `injectError(err)` (simulate sync error). Two `RecordingSyncAdapter`s pointed at separate `FlowDocument`s can replay each other's updates in vitest — the convergence property is testable without a Yjs server.

## SessionRegistry

Module-level `Map<flowId, { session, refs, pendingDestroy }>` keyed on `flowId`. Lives in `apps/web/src/session/session-registry.ts`. `acquireLocalSession()` / `acquireCloudSession(opts)` increment `refs` (cancelling any `pendingDestroy` timer); `releaseSession(flowId)` decrements and, when `refs` hits zero, schedules `destroy()` via `setTimeout(_, 100)`. The 100ms grace period absorbs React 18 Strict Mode's mount → unmount → mount cycle (second mount lands inside the window and reuses the same instance) and fast browser back-button navigation. Production behaviour with no Strict Mode is `refs: 1 → 0 → destroy after 100ms` — perceptually instant. Keyed on `flowId` so cross-mode navigation (`/flow/abc` → `/flow/local`) fully tears down without reuse. Pattern mirrors TanStack Query `gcTime`.

## FlowSessionProvider

React Context provider component. Lives in `apps/web/src/session/flow-session-context.tsx`. Wraps an editing subtree with one `FlowSession` value. One provider mounted per route layout — `LocalFlowLayout` and `CloudFlowLayout` in `apps/web/src/routes/flow/$flowId.tsx` each own one. Children call `useFlowSession()` to read; reading outside a provider throws (`"useFlowSession must be inside a FlowSessionProvider"`) so a misplaced consumer surfaces immediately rather than silently no-op'ing. The Context value is the session reference (rare change); high-frequency reactive data (nodes, edges, sync state) bypasses Context via Y.Doc observers and `RemoteSyncAdapter.on(...)` subscriptions.

For non-editable surfaces that still render real node components (thumbnails, template cards) use the **PreviewFlowSessionProvider** wrapper (`apps/web/src/session/preview-flow-session-provider.tsx`). It seeds a throwaway `FlowSession` via `createPreviewSession(nodes, edges)` — a fresh `FlowDocument` paired with a `NoOpSyncAdapter` that doesn't persist or connect — so node components calling `useFlowSession()` resolve to a real (but ephemeral) session instead of throwing. The session is destroyed when the provider unmounts; the nodes/edges identity drives rebuilds.

## FlowUpdateDispatcher

Class that observes a `FlowSession`'s `FlowDocument` for any Y-update (local edits AND remote sync arrivals), schedules a dispatch via an injected `DispatchScheduler`, then builds a `FlowUpdate` payload and ships it through an injected `FlowUpdateSender`. Lives in `apps/web/src/session/flow-update-dispatcher.ts`. Five injected dependencies, each with a production and test impl:

- **`FlowSession`** — the doc to observe.
- **`HostSnapshotProvider: () => HostSnapshot`** — re-read on every dispatch so credential rotation (MQTT password, LLM API key) takes effect on the next call without rebuilding the dispatcher.
- **`FlowUpdateSender`** — transport. Production: `TauriFlowUpdateSender` (wraps `invokeCommand("flow_update", ...)`). Tests: `RecordingFlowUpdateSender` (captures every dispatched payload, supports scripted errors via `scriptError(msg)`).
- **`DispatchScheduler`** — debounce strategy. Production: `DebounceScheduler` (500ms via `@tanstack/react-pacer`). Tests: `ManualDispatchScheduler` with `.flush()` for deterministic assertions.
- **`NodeAdapterRegistry`** — minimal `Record<instance, { adapter? }>` shape the dispatcher needs from the codegen'd `NODE_REGISTRY`. Injected (not imported) so the dispatcher module doesn't pull every node component + its env/auth deps into tests.

The pure compositional helpers, each independently testable:

- **`applyHostAdapterPatches(nodes, hostState, registry)`** — walks each node's **Host Adapter** to apply `prepareData` patches and collect broker IDs. Returns `{ nodes, brokerIds }`.
- **`gatherBrokers(brokerIds, allBrokers)`** — filter + project to the wire shape the runtime expects.
- **`gatherProviders(allProviders)`** — project LLM provider configs to the snake-case wire shape.
- **`buildFlowUpdate(doc, snapshot, registry)`** — composes the three helpers into a complete `FlowUpdate`. Pure: same inputs → same payload.

Mounted by the desktop layout only — the `useFlowUpdateDispatcher(session)` hook is `isDesktop`-gated at the route, never inside the dispatcher itself, so platform concerns don't leak into the dispatch layer. Construction fires an immediate dispatch so the runtime gets the current flow on mount (matches the legacy `setupDocSync` behaviour). Because the observer fires on every Y.Doc mutation regardless of origin, remote collaborator edits arriving via `WebSocketSyncAdapter` also dispatch to the local runtime, keeping the native runtime in sync with whatever the user sees on screen.

## ReactFlowBridge

Bidirectional reconciler between a `FlowDocument` (Y.Doc CRDT) and the [ReactFlow](https://reactflow.dev) change protocol. Lives in `apps/web/src/session/react-flow-bridge.ts`. One instance per canvas mount; the hook `useReactFlowBridge(doc)` constructs and tears down via `useState` lazy init + `useEffect` cleanup, exposes a `useSyncExternalStore`-backed snapshot. Five named invariants live on the class:

- **`classifyNodeChange` / `classifyEdgeChange`** (static, pure) — decide whether a `NodeChange` / `EdgeChange` is `"structural"` (flows to Y.Doc) or `"ephemeral"` (local React state only). `select` is always ephemeral; `position` is ephemeral while `dragging === true`, structural on drag-end; `add` / `remove` / `dimensions` / `replace` are always structural.
- **`isFlushingToDoc`** — loop guard. Set during the bridge's own `transact("local")` so the synchronous Y.Map observer fire skips the merge-back. Replaces the legacy `pendingYjsSync` ref trick.
- **`mergeYjsIntoSnapshot`** (static, pure) — carries `selected` / `dragging` from the current React snapshot onto an incoming Y.Doc snapshot; those fields never round-trip through Y.Doc.
- **`nodeNeedsWrite`** (static, pure) — diff skip rule: if position + dimensions match the existing Y.Map entry, no write.
- **`scheduleFlush` / `flush`** — RAF-batched structural writes. Multiple `applyNodeChanges` / `applyEdgeChanges` calls in one frame coalesce into one `transact("local")` and therefore one `UndoManager` entry. `flush()` is public so tests and callers needing a write barrier (e.g. before navigation) can force the flush synchronously.

Each invariant is independently unit-testable (28 vitest cases in `__tests__/react-flow-bridge.test.ts`, including a convergence-via-`RecordingSyncAdapter` headline test that proves CRDT replay end-to-end without a React renderer). Drag-during positions are **not** sent over the doc today — the right channel for ephemeral peer state is Yjs awareness, not the doc, and a future enhancement will broadcast `draggingNode: { id, position }` via `RemoteSyncAdapter.updateCursor`-style awareness so live collaborators see smooth drag motion without polluting undo history.
