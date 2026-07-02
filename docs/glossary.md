# Glossary — Ubiquitous Language

Shared domain vocabulary for microflow. One Flow can run two ways — interpreted live over a serial tether, or compiled ahead-of-time into a standalone Sketch — and most terms below are anchored to one of those execution targets. Add terms here as bounded contexts and concepts are defined.

> Conventions: **Bold** marks a defined term; _(established context)_ marks vocabulary the team has explicitly committed to. Issue links point at the GitHub issue that introduced a concept. Where a term names a class or file, a `path` hint follows.

## Bounded Contexts

- **Live Flow Runtime** — Executes a Flow by _interpreting_ it live in the Rust `FlowRuntime`, driving the board over **Firmata** across a serial tether. The board only acts while a computer is connected. Home of the **Component** trait, the **FlowExecutor** / **FlowRouter** event loop, and the **Board IO Loop**. _(established context)_
- **Sketch Generation** — Translates a Flow _ahead-of-time_ into an Arduino **Sketch** (`.ino`/C++) the board runs standalone, no host or Firmata. Shares the Flow graph and Node catalog with Live Flow Runtime; the two are sibling execution targets for one Flow. Each Node contributes a **NodeEmission** via its **Per-Node Code Template**. Introduced in [#22](https://github.com/xiduzo/microflow/issues/22).
  - **Networked Device** (sub-capability) — Generation path for **Cloud Nodes** (Mqtt, Figma, Llm, Monitor), which require a WiFi-capable **Board Target**, on-device network clients, and credential handling. [#22](https://github.com/xiduzo/microflow/issues/22).

## Core Flow Concepts

- **Flow** — The user-authored graph of Nodes and edges describing device behavior. The single artifact both execution targets consume.
- **Flow Graph** — The data model of a Flow: Nodes connected by directed **Edges** along which values travel.
- **Node** — A single building block in a Flow (e.g. Led, Button, Sensor, Calculate). Each Node has a `name` and an `impl`. Catalog: `apps/web/node-components.json`.
- **Impl** — The implementation a Node entry binds to (the Rust `Component` and matching React node module). Multiple catalog entries may share one impl (a Node **Variant**).
- **Edge** — A directed connection from a source Node's output **Handle** to a target Node's input Handle. Carries one value per fire.
- **Handle** — A typed connection point on a Node. Inputs sit on the left, outputs on the right. See **Handle Vocabulary**. `apps/web/src/components/flow/handle.ts`
- **Port** — A named input slot a **Component** declares and receives values on; the runtime delivers an edge value to a Port via **dispatch**. ("Handle" is the editor word; "Port" is the runtime word for the same input.)
- **Connection** — A user-drawn link between two compatible Handles that creates an Edge.
- **Canvas** — The editing surface (built on `@xyflow/react`/ReactFlow) where a **Flow Author** lays out Nodes and draws Connections.

## Handle Vocabulary

The handle system is a deliberate _uniform vocabulary_ — 15 canonical names and 4 types replace 40+ ad-hoc handle ids, so "the editor becomes a language, not a collection of dialects." `docs/HANDLE_SYSTEM.md`

- **Handle Type** — Every Handle has exactly one of four types, shown by shape:
  - **value** (● circle) — data flows here; input or output.
  - **event** (◆ diamond) — something momentary happened (a press, a tick, a threshold crossing); usually an output.
  - **command** (▶ triangle) — do this action now; input only.
  - **state** (■ square) — a current boolean condition (`true`/`false`); usually an output.
- **Canonical Handle Name** — The fixed set of handle ids:
  - Outputs (5): `value`, `event`, `true`, `false`, `hold`.
  - Inputs (10): `value`, `trigger`, `set`, `reset`, `start`, `stop`, `true`, `false`, `toggle`, `+` / `-` (ids `increment` / `decrement`).
- **Named Slot** — A semantic value handle used when a Node has more than one value input, e.g. `red`/`green`/`blue`/`alpha` (color channels), `min`/`max` (bounds), or `{{name}}`/`{{context}}` (LLM template vars). Still `value` type; the name only identifies the slot.
- **Handle Alias** — A map from a legacy handle id to its canonical name/type, so existing Flows keep resolving while the UI shows the new vocabulary. `HANDLE_ALIASES`

## Node Catalog & Families

The catalog (`apps/web/node-components.json`, 37 entries) groups Nodes into behavioral **families** by what they do to data:

- **Node Family** — One of: **sense** (read the physical world), **generate** (produce values), **shape** (transform values), **decide** (branch/gate on values), **express** (act on the world / reach a service). Mirrors the handle patterns in `docs/HANDLE_SYSTEM.md` §5.
  - _sense_: Button, Switch, Motion, Sensor, Proximity, Tilt, Ldr, HallEffect, Potentiometer, Hotkey, Force, I2cDevice.
  - _generate_: Constant, Interval, Oscillator, Counter.
  - _shape_: Calculate, RangeMap, Smooth, Trigger, Delay.
  - _decide_: Compare, Gate.
  - _express_: Led, Rgb, Pixel, Matrix, Relay, Servo, Stepper, Piezo, Vibration, plus the Cloud Nodes Mqtt, Figma, Llm, Monitor.
  - _utility_: Function (sandboxed custom JS), Monitor (debug sink).
- **Flow Author** — The maker (designer, engineer, hobbyist) who builds a Flow and wants it to run on their board.
- **Cloud Node** — A Node needing off-device networking: **Mqtt** (publish/subscribe to a broker topic), **Figma** (bridge a Figma design variable in/out over a broker), **Llm** (POST a prompt to an OpenAI-compatible endpoint), **Monitor** (publish received values to a monitor topic). Live, the host proxies the network; generated, the board does its own networking and the Node only runs on a networking-capable Board Target.
- **Function Node** — A Node that runs user-authored JavaScript in a sandbox; the seed of the planned **Plugin** system. `docs/FUNCTION_NODE.md`
- **I2cDevice** — A single generic Node that talks to any I2C peripheral by address + register, with optional **Device Presets** (BME280, BMP280, MPU6050, SHT21, …). `docs/I2C_SUPPORT.md`

## Live Flow Runtime — Execution

- **FlowRuntime** — The Rust host that owns the running Flow: component storage, the executor, and hardware callbacks. `apps/web/src-tauri/src/runtime/`
- **FlowExecutor** — The inner event loop: it pulls **Component Events** and turns them into **dispatch** calls.
- **FlowRouter** — The seam inside FlowExecutor that maps one outgoing Component Event to the list of target Ports it should be delivered to (owns edge indexing). [ADR-0002](adr/0002-flow-router-seam.md)
- **Component** — The Rust trait every Node impl satisfies. ADR-0001 keeps three input paths separate: edge inputs (**Ports**), self-routed **Internal Events**, and device-driven **Hardware Callbacks**. [ADR-0001](adr/0001-component-trait-flow-separation.md)
- **Component Event** — The value a Component emits (source node, source handle, value, sequence); the unit the FlowRouter routes.
- **Dispatch** — Delivering a value to a target Component's Port (`dispatch`) or to its own reserved handle (`dispatch_internal`).
- **Internal Event** — A self-routed emission whose `source_handle` is reserved (prefixed `_`); delivered back to the same Component rather than across an edge.
- **Hardware Callback** — A board-reader-driven event (a pin change or an I2C reply) delivered to a Component outside the Flow graph.
- **Capability Trait** — A narrow, per-capability service interface (LLM, MQTT, persistence, …) the runtime depends on, instead of one bundled `RuntimeContext`. Held in a **Service Registry**. [ADR-0002](adr/0002-per-capability-service-traits.md)

## Hardware & Protocol

- **Board** — The physical microcontroller. While tethered it runs **StandardFirmata** so the host can drive it.
- **Board Target** — The selected board model (`selectedTargetId`), e.g. Uno or ESP32. Determines pin map and whether networking (and thus Cloud Nodes) is available.
- **Firmata** — The serial protocol the Live Flow Runtime uses to read/write the Board's pins. **StandardFirmata** is the stock sketch flashed onto the Board to speak it.
- **Serial Tether** — The serial/Web-Serial link between host and Board; live execution exists only while it is connected.
- **Flashing** — Writing firmware to the Board — StandardFirmata for live use, or a generated Sketch to **Untether** it.
- **Pin** — A named Board I/O point (e.g. `D13`, `A0`) a Node claims. A Component sets its **Pin Mode** and enables reporting on `initialize`, and disables reporting on `destroy`. `docs/PIN_LIFECYCLE.md`
- **Pin Listener** — Runtime bookkeeping mapping a pin (or I2C address) to the Components waiting on it, so a Hardware Callback reaches the right Node.
- **Hot-Swap** — Reconfiguring a Flow while connected: old Components release their pins (reporting disabled) before new ones claim them, with a global reset + buffer flush as backstops. `docs/PIN_LIFECYCLE.md`
- **Board IO Loop** — The single thread that owns the serial port and emits pin-change / I2C-reply callbacks; Components reach it via a `BoardHandle` + `BoardCommand` channel rather than touching the port directly.
- **I2C** — Two-wire bus for register-addressed peripherals, carried over Firmata sysex (`I2C_CONFIG` / `I2C_REQUEST` / `I2C_REPLY`). See **I2cDevice**.

## Sketch Generation — Ahead-of-Time

- **Sketch** — The Arduino program (`.ino`/C++) generated from a Flow, runnable standalone.
- **Untether** — Make a Board run its Flow standalone, with no computer attached — the goal of Sketch Generation (flash a generated Sketch instead of StandardFirmata).
- **Per-Node Code Template** — A pure Rust `emit_*` function that turns one Node into C++ fragments; identical Node config yields byte-identical output (determinism). `crates/microflow-core/src/codegen/`
- **NodeEmission** — The struct a template returns: `includes`, `declarations`, `setup` (run once), and `loop_body` (run each tick). The assembler merges every Node's NodeEmission plus the WiFi preamble into one Sketch.
- **Driver Expression** — A C++ variable a source Node exposes (e.g. `button_b_1_pressed`) for downstream Nodes to read; computed once and indexed by source Node id.
- **WiFi Preamble** — The one-per-Sketch C++ block (include, SSID/password, connect-and-wait) emitted when a Cloud Node is present on a networking Board Target. Cloud Node templates assume WiFi is already up.
- **Credentials** — Per-generation secrets (WiFi, MQTT broker, LLM key) supplied at generation time, never persisted in the Flow; masked in debug, escaped into C++ literals, and checked for **Missing Credential** fields.
- **Cloud Node Validation Gate** — The rule rejecting Cloud Nodes on a non-networking Board Target before any code is emitted.

## Authoring & App Shell

- **Studio** — The desktop/web app (React + Tauri) where Flows are authored, run, and flashed.
- **Local Flow vs Cloud Flow** — A Local Flow lives on-device (`localStorage`, the default `LOCAL_FLOW`); a Cloud Flow is server-backed and collaborative.
- **Template** — A pre-built example Flow a Flow Author can open as a starting point.
- **Circuit** — The schematic/PCB view derived from a Flow (a wiring artifact, distinct from a code Sketch).
- **Inspector / Settings Panel** — The side panel that edits the selected Node's configuration **Fields** (not its Handles).

## Collaboration & Sync

- **Yjs (CRDT)** — The single source of truth for Flow _structure_. Yjs syncs Node positions/config, Edges, Flow metadata, and presence; it does **not** sync runtime values. `docs/SYNC_ARCHITECTURE.md`
- **FlowDocument** — The Y.Doc wrapper holding a Flow's Nodes, Edges, and meta, with an UndoManager for undo/redo. `packages/collab/src/schema.ts`
- **SyncProvider** — The WebSocket sync layer: offline queue, reconnect with backoff, awareness, typed events. `packages/collab/src/sync-provider.ts`
- **SyncAdapter** — Per-mode persistence/sync seam behind a FlowSession (e.g. remote/WebSocket vs local-storage), so the editor is agnostic to where a Flow lives. [ADR-0003](adr/0003-flow-session-seam.md)
- **FlowSession** — The frontend abstraction wrapping a FlowDocument + SyncAdapter + reactive Node/Edge state for one editing context. A **SessionRegistry** keeps a session alive across brief route changes (grace period). [ADR-0003](adr/0003-flow-session-seam.md)
- **Awareness / Presence** — Live broadcast of each **Collaborator**'s cursor and selection in a shared Flow.
- **Collaborator** — A Flow Author with access to a Cloud Flow, visible to others via Awareness.
- **Runtime Value** — A Node's live value (LED state, sensor reading). Local-only per user (Zustand `node-data` store), never synced — each user sees their own hardware. `apps/web/src/stores/node-data.ts`
- **Signal** — The transient animation on an Edge when a value travels it; a local visual cue, not synced. `apps/web/src/stores/signal.ts`

## Architecture Seams (frontend)

- **ReactFlowBridge** — Reconciles the FlowDocument (CRDT) with ReactFlow's change protocol, classifying each change as _structural_ (persisted to Yjs) or _ephemeral_ (local-only). [ADR-0004](adr/0004-react-flow-bridge.md)
- **FlowUpdateDispatcher** — Sends outbound Flow updates to the runtime via an injected `Sender`, `Scheduler`, and `NodeAdapterRegistry`. [ADR-0005](adr/0005-flow-update-dispatcher.md)

## Planned / Forward-Looking

_Not yet implemented — recorded so the vocabulary is reserved._ `docs/PLUGIN_SYSTEM.md`

- **Subflow** — A saved group of Nodes reused as a single composite "macro" Node, with exposed inputs/outputs (Plugin Tier 2).
- **Plugin** — A user-contributed custom Node. Planned in tiers: Soft (sandboxed JS, web-only) → Composite/Subflow → Blessed community → WASM.

## Architecture Decision Records

The ADRs under `docs/adr/` are the source of record for the runtime/sync seams above:

- [ADR-0001](adr/0001-component-trait-flow-separation.md) — Component trait separates Port, Internal Event, and Hardware Callback flows.
- [ADR-0002](adr/0002-flow-router-seam.md) — Extract FlowRouter as the routing seam inside FlowExecutor.
- [ADR-0002](adr/0002-per-capability-service-traits.md) — Per-capability service traits over a single `RuntimeContext` bundle.
- [ADR-0003](adr/0003-flow-session-seam.md) — `FlowSession` seam, per-mode `SyncAdapter`, grace-period `SessionRegistry`.
- [ADR-0004](adr/0004-react-flow-bridge.md) — `ReactFlowBridge` class extraction with named invariants.
- [ADR-0005](adr/0005-flow-update-dispatcher.md) — `FlowUpdateDispatcher` with injected `Sender`, `Scheduler`, `NodeAdapterRegistry`.
- [ADR-0006](adr/0006-rehost-runtime-on-core.md) — Re-host the Live Flow Runtime on `microflow-core` via a sans-IO `Effects` seam.
- [ADR-0007](adr/0007-node-wire-interface-emit-contract.md) — Bidirectional node wire-interface contract: typed Emits + live catalog-parity guard.
- [ADR-0008](adr/0008-effects-apply-policy.md) — `Effects` apply-policy: canonical order behind a typed `EffectsSink`.
- [ADR-0009](adr/0009-cloud-sans-io-capability.md) — Cloud as a sans-IO capability: cloud I/O becomes an `Effect`, performed per-host.
- [ADR-0010](adr/0010-subscription-diff-stays-per-host.md) — Subscription diff stays per-host; only winner-selection is core policy.
- [ADR-0011](adr/0011-figma-announce-protocol-in-core.md) — Figma announce protocol is core policy; uid extraction stays per-host.
- [ADR-0012](adr/0012-component-trait-plumbing-stays-explicit.md) — Component trait plumbing stays explicit (no derive macro); records the deferral + trigger.
