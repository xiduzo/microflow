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
| `impls[].ports`            | Rust + UI       | The declared **Port** set this impl accepts on `dispatch`. Asserted equal to `<Impl>::ports()` at registry construction; consumed by frontend codegen to emit `COMPONENT_PORTS` and `PortOf<T>`. See § Port. |

### Generation

The catalog drives both registries:

- `apps/web/scripts/codegen-node-registry.ts` reads `entries` → writes `apps/web/src/components/flow/nodes/_REGISTRY.ts` and `_base/_base.types.ts`. Run via `bun run codegen` in `apps/web`.
- `apps/web/src-tauri/build.rs` reads `entries` + `impls` → writes `$OUT_DIR/register_all_body.rs`, included from `apps/web/src-tauri/src/runtime/registry.rs` inside `ComponentRegistry::register_all`. Run automatically by cargo on JSON change.

## Component Registry

The Rust-side runtime view of the Component Catalog. Holds factory closures keyed by `entries[].name`. Built once at runtime construction; queried by `FlowRuntime::update_flow` to instantiate `Box<dyn Component>` per flow node.

## Variant

An `entries` row whose `impl` differs from its `name`. Reuses the parent impl's runtime behavior and TS schema. Examples: `Potentiometer`/`Force`/`Ldr`/`HallEffect`/`Tilt` over `Sensor`; `Vibration` over `Led`. Variants may override TS defaults (label, group, icon, subType) but cannot change runtime behavior — their factory delegates to the parent impl class.

## Category

A Rust module path under `runtime/`. Determines `use super::<category>::{<Impl>, <Impl>Config};` in generated registry. Distinct from TS-side `defaults.group` (which is a freeform UI grouping label).

## Component (Rust trait)

In `apps/web/src-tauri/src/runtime/component.rs`. The interface every impl satisfies. Decision and migration captured in `docs/adr/0001-component-trait-flow-separation.md` (see also `docs/RUNTIME_AUDIT_APRIL_2026.md` §3.5 / §3.3). Three distinct flows enter the trait, each with its own method:

- **Port** — edge inputs. Delivered via `dispatch(&str, ComponentValue)`. Each impl declares its accepted Port set via `fn ports() -> &'static [&'static str] where Self: Sized`.
- **Internal Event** — self-routed methods. Delivered via `dispatch_internal(&str, ComponentValue)`.
- **Hardware Callback** — board-reader-driven events. Delivered via `HardwareComponent::on_pin_change` / `on_i2c_reply`.

The shared underscore-prefix routing in `runtime/executor.rs::process_event` dispatches to the right method based on the reserved handle name; everything else is a Port.

## Port

A named edge-input slot on a **Component (Rust trait)**, delivered as `target_handle` from a flow edge into `Component::dispatch`. Each impl declares its closed Port set via `fn ports() -> &'static [&'static str]`. The set is mirrored to `node-components.json impls[].ports[]` and asserted equal at registry construction by `ComponentRegistry::register` / `register_hardware`; a drift panics at startup with a quoted diff. The frontend codegen (`apps/web/scripts/codegen-node-registry.ts`) emits `COMPONENT_PORTS` (a typed const object) and `PortOf<T>` (a literal-union helper) into `_base/_base.types.ts`, so ReactFlow target handles are type-checked against the same source of truth. Empty array for components with no edge inputs (e.g. `Constant`).

Examples: `Led` accepts `"true"/"false"/"toggle"/"value"`; `Stepper` accepts `"value"/"to"/"stop"/"zero"/"enable"`; `Button` accepts `"read"` (and receives the digital-pin Hardware Callback separately via `on_pin_change`).

Distinct from **Internal Event** names (never on edges, self-routed only) and **Hardware Callback** names (never on edges, runtime-delivered only).

## Internal Event

Self-routed method delivered when a **Component (Rust trait)** emits a `ComponentEvent` whose `source_handle` starts with `_` and is not a reserved **Hardware Callback** name. The executor (`runtime/executor.rs::process_event`) strips the leading `_` and calls `Component::dispatch_internal` on the source component. Used by components that schedule their own state transitions (e.g. `Piezo` `auto_stop` after a song-playback thread finishes). Never observable as a **Port** — edges cannot target an internal-event name.

## Hardware Callback

Board-reader-driven event delivered to a **HardwareComponent** in response to Firmata wire activity. Two live kinds today, routed by `runtime/executor.rs::process_event` to typed methods on `HardwareComponent`:

- `_pin_change` (from the **Board IO Loop**'s `PinChangeCallback`) → `on_pin_change(value)`. `value` is `Bool` for digital pins, `Number(u16)` for analog.
- `_i2c_reply` (from `I2cReplyCallback`) → `on_i2c_reply(value)`. `value` is `Array` of byte values.

Emission of these reserved handles is the runtime's responsibility (in `FlowRuntime::install_pin_change_callback` / `install_i2c_reply_callback`); no flow edge may emit them. A third reserved name `"stepper_reply"` is referenced in `Stepper::call_method` and the module docstring but has no current emission path — forward-looking placeholder pending stepper sysex wiring.

## FlowRouter

The seam that turns one outgoing `ComponentEvent` into the list of `DispatchCall`s the executor invokes. Lives in `apps/web/src-tauri/src/runtime/router.rs`. Owns the (source, source_handle) → target index (`EdgeMap` backed by `FxHasher` over both strings with a 0-byte separator) and the per-target delivery decision; nothing else in `FlowExecutor` knows the edge layout.

Two delivery shapes today, chosen per target via `ComponentLookup::aggregates(target_id)`:

- **Direct** — pass `event.value` (cloned once) through to one target. The default for non-aggregating targets.
- **Snapshot** — collect every source feeding the same `(target_id, target_handle)` via `ComponentLookup::value_of(source)` and wrap as `ComponentValue::Array`. Chosen for targets that return `Component::aggregates_inputs() == true` (today `Calculate`, `Gate`). The just-emitted source must already have been `set_value`'d by the executor's echo step, or snapshot reads a stale value for it — see `runtime/executor.rs::process_event`.

`ComponentLookup` is a 2-method trait (`aggregates`, `value_of`) the executor satisfies with a thin `ComponentMapLookup` adapter over its `HashMap<String, Box<dyn Component>>`. The router has no opinion about how components are stored; router tests pass a `HashMap<String, (bool, ComponentValue)>` mock and never instantiate real Components.

Internal Events and Hardware Callbacks never reach `FlowRouter` — source == target by construction, dispatched straight from `executor::process_event`. Stale-sequence gating also happens upstream of `route()`. Decision and migration captured in `docs/adr/0002-flow-router-seam.md`.

## BoardHandle

Public flow-runtime seam to the connected Firmata board. Lives in `apps/web/src-tauri/src/runtime/board/handle.rs`. Hardware **Component** impls receive `Arc<BoardHandle>` via `Component::initialize` and call typed methods (`set_pin_mode`, `digital_write`, `analog_write`, `enable_analog_reporting`, …) returning a [`CommandReceipt`](#commandreceipt). Each typed method allocates a oneshot reply, enqueues a `BoardCommand` on the **Board IO Loop**'s channel, and returns the receipt — never blocks on the serial port. Hot-path Component callers call `.ignore()` to make fire-and-forget intent explicit; Tauri callers `.into_future().await` for the wire result; tests use `.wait()` or `BoardHandle::test_pair()` with a [`TestIoLoop`](#testioloop). Read-side: `pin_snapshot(pin) -> Option<PinSnapshot>` returns a point-in-time view of the cached pin value; live reads still flow through the `on_pin_change` callback path established by [ADR-0001](docs/adr/0001-component-trait-flow-separation.md). Five non-seam methods (`set_pin_change_callback`, `set_i2c_reply_callback`, `clear_pin_cache`, `register_active_pin`, `unregister_active_pin`) write directly to shared state and still return `Result<(), RuntimeError>`.

## Board IO Loop

Single-thread engine that owns the **BoardConnection** exclusively. Lives in `apps/web/src-tauri/src/runtime/board/io_loop.rs`. Drains a `mpsc::Receiver<BoardCommand>` between Firmata reads: pull all pending commands → mutate connection → read one Firmata message → emit pin-change / I2C-reply events → repeat. The channel is the synchronization primitive — `firmata-rs` requires `&mut self` for every op including reads, so a shared `Mutex<BoardConnection>` would starve writers behind blocking reads. This loop is the only place `&mut BoardConnection` exists.

## BoardConnection

Private `firmata-rs` wrapper held by the **Board IO Loop**. Lives in `apps/web/src-tauri/src/runtime/board/connection.rs`. Owns the open serial port. Pin-value cache and active-pin set are `Arc<DashMap>` fields shared read-only with **BoardHandle**; pin-change / I2C-reply callbacks are closure-captured at IO-loop spawn. Never escapes the loop's thread.

## BoardCommand

Internal protocol between **BoardHandle** and the **Board IO Loop**. Enum carrying Firmata wire ops (`SetPinMode`, `DigitalWrite`, `AnalogWrite`, `ShiftOut`, `Tone`, `Sysex`, `Enable/DisableAnalog/DigitalReporting`, `ResetAllReporting`, the I2C ops) plus `Stop`. Every wire-op variant carries `reply: oneshot::Sender<Result<(), HardwareError>>`; the IO loop fills the reply after running the underlying `BoardConnection` call, and `BoardHandle` wraps the matching `Receiver` in a [`CommandReceipt`](#commandreceipt). Constructed only by `BoardHandle` typed methods — production callers never see it. Re-exported from `board::mod` so the **TestIoLoop** can pattern-match in integration tests.

## CommandReceipt

Outcome handle returned by every **BoardHandle** write method. Lives in `apps/web/src-tauri/src/runtime/board/handle.rs`. Wraps a `oneshot::Receiver<Result<(), HardwareError>>` that the **Board IO Loop** resolves after it runs the underlying **BoardConnection** call. Three consume methods: `wait()` (sync, blocks — used inside `Component::call_method`), `into_future()` (async — `.await` from Tauri commands), `ignore()` (drops the receipt, making fire-and-forget intent visible at the call site). `try_now(&mut self)` is a non-blocking peek.

Resolves to `HardwareError::Disconnected` if the IO loop shut down before the command was processed, to the underlying `HardwareError` variant if `BoardConnection`'s call failed, or to `Ok(())` after a successful wire write.

The receipt makes the **BoardCommand** channel into a real seam: tests pair a real **BoardHandle** with a **TestIoLoop** that records each command and scripts the outcome, replacing the parallel `MockBoardHandle` that previously asserted at the call site instead of at the wire.

## PinSnapshot

Point-in-time read of a pin's cached value, returned by `BoardHandle::pin_snapshot(pin) -> Option<PinSnapshot>`. Lives in `apps/web/src-tauri/src/runtime/board/handle.rs`. Replaces the bare `pin_value(pin) -> Option<u16>` getter, which silently returned stale data after the board disconnected.

Carries `value: u16`, `captured_at: Instant` (last time **BoardConnection** observed this pin), and `board_connected: bool` (connection state at read time, not at capture time). Tauri commands serving the UI can distinguish "fresh, board live" from "last known, board gone" without consulting a separate `is_connected()` method.

Live reads (edge components reacting to pin changes) still flow through the `on_pin_change` callback path established by [ADR-0001](docs/adr/0001-component-trait-flow-separation.md). `PinSnapshot` is for snapshot queries only, not subscriptions.

## TestIoLoop

Test-mode replacement for the **Board IO Loop**. Lives in `apps/web/src-tauri/src/runtime/board/test_io_loop.rs`. Constructed via `BoardHandle::test_pair() -> (Arc<BoardHandle>, TestIoLoop)`. Drains the same `BoardCommand` channel as the production IO loop but, instead of running a `BoardConnection`, records each command in a `pending` vec and lets the test script the outcome: `take_next() -> Option<BoardCommand>` for pattern-matching, `complete_next(outcome)` to script a single reply, `complete_all_ok()` to bulk-resolve.

`TestIoLoop` is the second adapter at the `BoardCommand` seam — the production IO loop is the first — which is what makes the seam a real seam rather than a hypothetical one. Tests assert what was sent over the wire (`BoardCommand::DigitalWrite { pin: 13, value: true, .. }`) and drive **Component**s through both success and failure paths without hardware. The standalone `MockBoardHandle` in `tests/common/mock_board.rs` is a HashMap-with-flag scaffold, never substituted for `BoardHandle`; it is unrelated to this seam.

## Wiring

Per-impl description of how a constructed **Component** attaches to its execution environment. Returned as plain data from the trait (or sibling `ExternalSubscriber` trait); the runtime reads and applies it without naming any specific component.

Replaces the instance-name `match` blocks formerly in `runtime/mod.rs::register_component_pin_listener` and `runtime/commands.rs::extract_*`. Wiring is **descriptive, not active** — components return data, runtime acts. Lets a component's wiring be tested as a value, no `&mut self`, no sinks.

Two kinds:

- **Listener Wiring** — sync, in-process. Pin (digital, or analog with threshold), I2C address, hotkey accelerator. Returned from `Component::listener_wiring()` as `Vec<ListenerWiring>`.
- **Subscriber Wiring** — async, broker-dependent. MQTT topic + handler kind. Returned from `ExternalSubscriber::subscriber_wiring()` (only impl'd by components that need brokers, e.g. `Mqtt`, `Figma`).

Distinct from the **Component Catalog**: catalog is metadata for _registration_ (what UI shows, how to construct); Wiring is per-impl _behavior_ applied after construction.

## Runtime Context

Read-only bundle passed to component factories at construction time: connected brokers, configured LLM providers. Lets a component pluck the bits it needs (e.g. `Llm` reads its provider's `base_url`/`api_key`) without mutating `node.data` upstream. Empty for components with no external deps.

_Deprecated by [ADR-0002](docs/adr/0002-per-capability-service-traits.md); will be replaced by **Runtime Services** + per-impl **Component Deps** in Phase 4. The struct still ships today as `runtime/context.rs::RuntimeContext { providers: Vec<ProviderEntry> }` and is read only by `Llm::build`._

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

## Host Adapter

Frontend mirror of **Wiring**. Each node component module may export an `adapter: NodeHostAdapter` (see `apps/web/src/components/flow/nodes/_base/host-adapter.ts`) describing what the host store + global hotkey listener need from this node:

- `prepareData(node, hosts)` — partial `data` patch to merge before sync (e.g. `Figma` injects `uniqueId` from `useFigmaStore`).
- `brokerIds(node)` — broker IDs this node depends on; collected and forwarded to the runtime.
- `accelerator(node)` — keyboard accelerator this node listens to; registered with `useHotkeys`.

The catalog `impls[].usesHostAdapter` flag drives codegen: when `true`, `_REGISTRY.ts` imports the entry's `adapter` export. The frontend registry exposes `adapter` on every entry (undefined when no adapter is needed), so consumers walk it without pattern-matching `data.instance`.
