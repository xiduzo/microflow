# Rust Runtime Architecture

How the Rust side of Microflow is put together: the shared engine in
`microflow-core`, and the Tauri desktop backend that hosts it. For the browser's
side of the same engine see [WASM_BOUNDARY.md](WASM_BOUNDARY.md); for the
vocabulary used here see [CONTEXT.md](../CONTEXT.md); for the reasons behind the
shape see the ADRs in [`docs/adr/`](adr/).

---

## Table of Contents

1. [Overview](#overview)
2. [Module Architecture](#module-architecture)
3. [Data Flow](#data-flow)
4. [Nodes](#nodes)
5. [Hardware Integration](#hardware-integration)
6. [MQTT Subsystem](#mqtt-subsystem)
7. [Flasher](#flasher)
8. [Threading Model](#threading-model)
9. [Development Guide](#development-guide)
10. [Appendix: Tauri Commands](#appendix-tauri-commands)
11. [Appendix: ComponentValue](#appendix-componentvalue)

---

## Overview

There is one flow engine, and it does no I/O. `microflow-core` holds the engine,
the Firmata codec, the board bring-up policy, the bootloader drivers and sketch
generation. A **Runtime Host** drives it on each platform
([ADR-0006](adr/0006-rehost-runtime-on-core.md)):

- the **desktop** host is the Tauri backend described here, which runs core
  natively;
- the **browser** host runs the same core compiled to WebAssembly.

The desktop backend adds what only a native process can do: open serial ports,
hold MQTT connections over TCP and TLS, open MIDI ports, run agent CLIs, and
flash a board without asking the user to pick a port.

### Key Files

```
crates/
├── microflow-core/          # The engine and everything platform-independent
│   └── src/
│       ├── runtime/         # FlowRuntime, router, registry, Effects (feature `runtime`)
│       ├── nodes/           # One folder per node: config, runtime, codegen
│       ├── config/          # Node config resolution, shared by runtime and codegen
│       ├── firmata/         # Firmata codec, pin profile, safe state, sim board
│       ├── flasher/         # Bootloader drivers, hex parser, firmware images
│       ├── codegen/         # Arduino sketch generation
│       └── bringup.rs       # Board bring-up state machine
├── microflow-runtime-wasm/  # wasm-bindgen shim over the engine
├── microflow-firmata-wasm/  # wasm-bindgen shim over codec, bring-up, flash drivers
└── microflow-codegen-wasm/  # wasm-bindgen shim over sketch generation

apps/web/src-tauri/          # The desktop backend
├── Cargo.toml
├── src/
│   ├── main.rs              # Entry point
│   ├── lib.rs               # App setup, AppState, plugin and command wiring
│   ├── runtime/             # The desktop Runtime Host: actor, CloudPerformer, MIDI
│   ├── hardware/            # Port monitoring and the board link
│   ├── mqtt/                # MQTT broker pool
│   ├── flasher/             # The desktop flash executor
│   ├── mcp/                 # Flow tools published to agent CLIs over MCP
│   ├── cli_llm.rs           # The agent CLI commands: probe, models, generate, stop
│   ├── cli_llm/runs.rs      # AgentCliRuns: owns every agent CLI process the app starts
│   └── tray.rs
└── tests/                   # catalog_parity, flow_update, mqtt_pool, mqtt_reconnect, mqtt_routing
```

### Dependencies

The desktop crate's main dependencies (`apps/web/src-tauri/Cargo.toml`):

| Crate | Purpose |
|-------|---------|
| `microflow-core` (features `runtime`, `js`, `cloud`) | The engine and all shared logic |
| `tauri` 2.x and its plugins | Desktop app framework, updater, dialogs, deep links, HTTP |
| `serialport` 4 | Serial port access |
| `midir` | MIDI ports |
| `tokio` | Timers, MQTT tasks, subprocesses |
| `mqtt-endpoint-tokio` | MQTT client |
| `ts-rs` | TypeScript bindings generated from Rust types |
| `tracing`, `tauri-plugin-log` | Flow-turn tracing and application logs |

The Firmata protocol implementation is core's own (`microflow_core::firmata`);
there is no third-party Firmata crate.

---

## Module Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                             lib.rs                               │
│  AppState · plugin registration · Tauri commands · key_event     │
└──────────────────────────────────────────────────────────────────┘
        │                    │                     │
        ▼                    ▼                     ▼
┌────────────────┐  ┌──────────────────┐  ┌─────────────────┐
│   runtime/     │  │    hardware/     │  │     mqtt/       │
│                │  │                  │  │                 │
│ host (actor)   │◀─│ HardwareService  │  │ MqttManager     │
│ CloudPerformer │  │ BoardLink        │  │ MqttBroker      │
│ MidiManager    │  │ port monitor     │  │ broker sessions │
│ supervisor     │  │ Firmata detection│  │                 │
└────────────────┘  └──────────────────┘  └─────────────────┘
        │                    │                     ▲
        │                    ▼                     │
        │           ┌──────────────────┐           │
        │           │    flasher/      │           │
        │           │ flash executor   │           │
        │           └──────────────────┘           │
        │                                          │
        └────── CloudPerformer publishes and subscribes ──┘

                 all of it drives  microflow-core
```

### Module Responsibilities

| Module | Single Responsibility |
|--------|----------------------|
| `runtime/host.rs` | The actor thread: owns the `FlowRuntime` and the open port, turns each message into one runtime turn, applies its `Effects` |
| `runtime/cloud_performer.rs` | Publishes what cloud nodes record and owns the flow's MQTT subscriptions |
| `runtime/midi.rs` | Opens and closes MIDI ports; forwards raw messages to the actor |
| `runtime/supervisor.rs` | Crash-loop guard and panic fingerprint for the actor |
| `runtime/commands.rs` | Tauri commands that post messages to the actor |
| `hardware/` | Detect ports, decide which one is the board, bring it up, report board state |
| `mqtt/` | Hold one connection per broker; connect, publish, subscribe |
| `flasher/` | Carry a core flash driver's steps out on a serial port |
| `mcp/` | Serve the webview's flow tools to an agent CLI for the length of a turn |
| `cli_llm` | Run agent CLIs; every process is an **Agent CLI run** owned by `AgentCliRuns` |

---

## Data Flow

### One turn

Everything that happens to a flow is a **turn**: one call into the `FlowRuntime`
that returns one `Effects` record. The actor never lets a node touch the port, a
clock or a timer; it applies the `Effects` afterwards, in the order core fixes
([ADR-0008](adr/0008-effects-apply-policy.md)).

```
ActorMsg (or bytes read from the port)
        │
        ▼
┌──────────────────────────┐
│ FlowRuntime entry point  │  update_flow · feed_bytes · wake · dispatch
│ (microflow-core)         │  deliver_message · inject_event
└────────────┬─────────────┘  dispatch_key_event · dispatch_midi_message
             │ Effects
             ▼
┌──────────────────────────┐
│ Effects::apply           │  1. outbound_bytes   → serial port
│ (the actor is the sink)  │  2. cancellations    → abort Tokio timers
│                          │  3. wakeups          → arm Tokio timers
│                          │  4. cloud_requests   → CloudPerformer / webview
│                          │  5. component_events → "component-events" to the webview
└──────────────────────────┘
```

Node diagnostics travel in the same record and reach the webview as
`node-diagnostic` events.

### Flow update

```
Webview                               Backend
   │  flow_update { flow, brokers }      │
   │ ───────────────────────────────────▶│  connect the brokers that are not connected yet
   │                                     │      (waits at most BROKER_GRACE, 2 s, for all;
   │                                     │       once for each time a broker is down)
   │                                     │  ActorMsg::FlowUpdate ──▶ actor
   │                                     │      FlowRuntime::update_flow  (one turn)
   │                                     │      CloudPerformer::reconcile (subscriptions)
   │                                     │      MidiManager::reconcile    (MIDI inputs)
   │◀─────────────────────────────────── │  replies once that reconcile is applied
```

A broker that is still connecting after the grace does not hold the flow back or
fail the update. Its connect carries on, and the `CloudPerformer` subscribes the
flow's topics on it when it comes up. A broker that stays away gets one grace:
the updates that arrive within it wait for what is left of it, and later ones
do not wait. It gets a grace again once it came up or got other settings
(`MqttManager::stretch`).

Updates are applied in the order they arrive (`FlowUpdates`,
`runtime/commands.rs`). They are numbered as they arrive, and one is handed to
the actor only while it is the newest. An update still waiting for its brokers
when a newer one arrives is replaced: it is never applied, and it answers as
the update that replaced it does.

The actor keeps the last flow, so a board that connects later, a respawn after a
panic, and a restart after a halt all re-apply it without the webview sending it
again.

### Inbound events

| Source | Arrives as | Runtime entry point |
|--------|-----------|---------------------|
| Bytes from the board | read by the actor from its port | `feed_bytes` |
| A timer the runtime armed | `ActorMsg::Wake` | `wake` |
| A broker message | `ActorMsg::Deliver` | `deliver_message` |
| An LLM result from the webview | `llm_result` command → `ActorMsg::Inject` | `inject_event` |
| A key press or release | `key_event` Tauri event → `ActorMsg::Key` | `dispatch_key_event` |
| A MIDI message | `ActorMsg::MidiMessage` | `dispatch_midi_message` |
| A value sent from the editor | `component_call` command → `ActorMsg::Call` | `dispatch` |

A key or a MIDI message carries no node id. The runtime picks the nodes that
listen for it and delivers to them in node-id order within the one turn
([ADR-0037](adr/0037-core-owns-host-input-fan-out.md)).

---

## Nodes

Every flow node implements the `Component` trait in
`crates/microflow-core/src/runtime/component.rs`. A node's Rust code lives in
its own folder, `crates/microflow-core/src/nodes/<node>/`
([ADR-0026](adr/0026-node-code-colocated-per-node.md)):

| File | Holds |
|------|-------|
| `config.rs` | The node's config struct, read from the editor's `data` |
| `runtime.rs` | The live behaviour (behind the `runtime`, `cloud` or `js` feature) |
| `codegen.rs` | The Arduino sketch emitter |

A node has only the layers it needs. Nodes are registered by hand in
`register_all` (`crates/microflow-core/src/runtime/registry.rs`), and the
desktop and the browser get the same set from that one place. The desktop crate
contains no node code.

The registry reads a node's `data` into its config through `config::resolve`
(`crates/microflow-core/src/config/mod.rs`), the same step sketch generation
uses. A `data` that cannot be read is `RuntimeError::ConfigDeserialize`: the
node does not run and says why, and no default config is used in its place
([ADR-0033](adr/0033-one-node-config-resolution.md)).

During a turn a node is handed a `RuntimeContext`: a board writer that encodes
Firmata bytes into the turn's buffer, the engine clock, and a wakeup scheduler. It
cannot block, sleep or read.

The engine clock is the time the host handed in (`FlowRuntime::set_now`); a node
reads it with `ctx.now_ms()`. Core never reads the OS clock: on
`wasm32-unknown-unknown` that panics. `clippy.toml` in `microflow-core` and
`microflow-runtime-wasm` bans `std::time::Instant` and `std::time::SystemTime`.

A node that holds values over time holds the same bounded number live and in
the sketch, read from one constant in its `config.rs`. A Delay holds
`DelayConfig::capacity()` triggers: 16 for a **Queue (Delay)**, 1 for a
**Debounce (Delay)**. A **Trigger window** holds at most 16 values
(`WINDOW_CAPACITY`). In both, a value that arrives when the node is full
replaces the newest one it holds.

To add a node, follow
[Adding a node](../apps/fumadocs/content/docs/contributing/adding-a-node.mdx).

---

## Hardware Integration

### Connection lifecycle

```
port scan (every 250 ms)
      │
      ▼
BoardLink ── decides which port is the board, and what to do next
      │
      ├─ probe      Firmata detection on the port
      ├─ flash      StandardFirmata, if the board has none (see Flasher)
      └─ connect    hand the open port to the actor as a Board Session
```

`hardware/board_link.rs` is the one owner of connection state. The monitor
thread feeds it port scans and session ends; it drives core's bring-up machine
(`microflow_core::bringup`) and performs the actions that come back. The policy
itself — when to probe, when to flash, when to retry — is core's and is shared
with the browser.

A board is flashed without asking only when its USB ids positively identify an
official Arduino. A board on a generic USB-serial chip gets an offer the user
must confirm ([ADR-0031](adr/0031-positive-identification-before-auto-flash.md)).

### The actor owns the port

On connect the actor receives `ActorMsg::Connect { port, pins_json, session }`,
seeds the runtime's pin table and re-applies the last flow. From then on the
actor reads and writes the port itself. A read or write that fails ends the
session: the actor reports it once and the board link decides what happens next.

### Letting go of a board

Before the actor drops a healthy session it writes the **safe state**: every
digital port 0, a Firmata `SYSTEM_RESET`, every port 0 again
(`microflow_core::firmata::encode_safe_state`). It does so on disconnect, on app
exit and before a respawn.

---

## MQTT Subsystem

### The broker pool

```
┌──────────────────────────────────────────────────────────┐
│                      MqttManager                         │
│  one connection per broker id                            │
└──────────────────────────────────────────────────────────┘
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
    ┌─────────────────┐       ┌─────────────────┐
    │   MqttBroker    │       │   MqttBroker    │
    │   (broker-1)    │       │   (broker-2)    │
    └─────────────────┘       └─────────────────┘
```

Each broker the pool holds is in one **broker session**. It starts when the
broker is first connected and ends when it is disconnected or connected with a
different config. A dropped link is repaired inside the session, and the
session keeps its subscriptions across it. Each time the session's link comes
up it gets a new `link` number (`BrokerSession.link`), so whoever told the
broker something can tell whether the broker may have lost it since.

**The last settings win.** `connect` gives the pool a broker's settings, with a
generation; `disconnect` and `remove` withdraw them. A connect dials without the
pool lock, so several attempts for one broker id can be in flight. An attempt
goes into the pool only if its generation is still the broker's, checked under
the lock; otherwise it is given up and its link closed. `MqttManager::sync`
(the `mqtt_sync_brokers` command) takes the whole broker list. Lists are
numbered as they arrive and applied one at a time. A list that a newer one has
overtaken is not applied, and no broker is waited for.

**Bounds.** A connect attempt is bounded by `CONNECT_TIMEOUT` (30 s). Every
write to a link (SUBSCRIBE, UNSUBSCRIBE, PUBLISH, DISCONNECT) is bounded by
`WRITE_TIMEOUT` (10 s). A write that is not through in time fails, and the link
is treated as dropped: the client is `Disconnected` and its reconnect loop
repairs it.

**Last words and the will.** The `CloudPerformer` gives the pool the
`disconnected` of each Bridge ID it announced on a broker
(`MqttBrokers::set_last_words`). The pool publishes them before the DISCONNECT
when it ends a session on purpose, if the link is up, within
`LAST_WORDS_TIMEOUT` (2 s) and with the pool unlocked. Each of them is also a
will, which the broker publishes if Studio goes without a goodbye. MQTT gives a
link one will and fixes it when the link opens. The first is the session's
will, on its main link: a changed will opens a new link that carries it, moves
the subscriptions to it, and then disconnects the old link. Each further one is
held by a will link (`mqtt/will_links.rs`): an idle link of its own, with no
subscriptions, that publishes its goodbye right before its DISCONNECT when its
Bridge ID leaves or the session ends on purpose. A will link that is up says
its own goodbye; the main link says those of the will links that are not.

**Status.** The pool ticks whenever a broker's status may have changed.
`report_broker_statuses` turns the ticks into the `mqtt-broker-status` event,
sent only when the list differs from the last one. Each list is a numbered
**Status snapshot** (`BrokerStatuses { seq, brokers }`); the webview keeps the
one with the highest `seq`.

### Supported URL schemes

| URL Scheme | Transport | Default Port |
|------------|-----------|--------------|
| `mqtt://` | TCP | 1883 |
| `mqtts://` | TLS | 8883 |
| `ws://` | WebSocket, connected over TLS | 80 |
| `wss://` | WebSocket + TLS | 443 |

A URL with no scheme is read as `mqtt://`.

### How a flow uses it

The `Mqtt` and `Figma` nodes do no network I/O. A node that publishes records a
`CloudRequest` in the turn's `Effects`; a node that subscribes declares a
subscriber wiring. The `CloudPerformer` turns both into calls on the pool:

- `perform` publishes what a turn recorded;
- `reconcile` makes the brokers' subscriptions match the flow's wirings, keeps
  them matched as broker sessions start, end or get their link back, and
  announces Studio to the design-tool plugins.

It reaches the pool through the `MqttBrokers` trait
(`runtime/services/mqtt.rs`), which `MqttManager` implements in the app and a
recording pool implements in tests. An inbound message returns to the runtime as
`ActorMsg::Deliver` and is echoed to the webview as `mqtt-message`
([ADR-0035](adr/0035-desktop-cloud-performer-owns-subscriptions.md)).

The pool speaks MQTT 5. Each filter a client holds has a subscription
identifier of its own (`Subscriptions` in `mqtt/broker.rs`), kept for as long
as the filter is held. A message reaches the subscriptions whose identifiers it
carries and whose filter matches its topic (`MqttBroker::topic_matches`), once
each, whether the broker sends one copy for all of them or one per filter. A
message with no identifier, or any message on a link whose CONNACK announced no
subscription identifiers, reaches every filter its topic matches. A retained
replay reaches only a subscriber that has had no message on that topic since it
joined.
The browser host's `topicMatches` is the same rule: both are held to one case
table, `packages/design-bridge/fixtures/topic-filter.json` (`tests/mqtt_routing.rs`).
A topic with a wildcard is never published.

The Connection Console subscribes on the same pool as a separate subscriber
(`Subscriber::Console`), through the `mqtt_subscribe`, `mqtt_unsubscribe` and
`mqtt_publish` commands. Console subscriptions belong to the broker id. An
unsubscribe ends the console's hold at once, whatever the link does; the
UNSUBSCRIBE goes out when the link takes it. A page reload drops every console
subscription (`on_page_load`).

### Ending sessions on quit

When the app quits, the exit handler stops the actor (within `SHUTDOWN_GRACE`,
500 ms), ends every Agent CLI run, and then calls `MqttManager::disconnect_all`
within `QUIT_GRACE` (2.5 s). Every session ends at once, says its last words if
its link is up, and sends DISCONNECT. A link that is not through in time is
closed with the process, and its broker publishes the session's will. A page
reload says no goodbye: the actor keeps running the flow.

---

## Flasher

### Supported boards

| Board | Board id | Bootloader protocol | Bootloader baud |
|-------|----------|---------------------|-----------------|
| Arduino Uno | `uno` | STK500v1 | 115200 |
| Arduino Nano (older bootloader) | `nano` | STK500v1 | 57600 |
| Arduino Nano (newer bootloader) | `nanoNew` | STK500v1 | 115200 |
| Arduino Mega 2560 | `mega` | STK500v2 | 115200 |
| Arduino Leonardo | `leonardo` | AVR109 | 57600 |
| Arduino Micro | `micro` | AVR109 | 57600 |

### Drivers and executors

The bootloader protocols are not in the desktop crate. Each is a sans-IO
`FlashDriver` in `crates/microflow-core/src/flasher/` (`stk500v1.rs`,
`stk500v2.rs`, `avr109.rs`). A driver owns the whole protocol: the bytes, the
reset sequence, the sync retries, the baud fallback, the timeouts and when to
give up. It asks for one `FlashStep` at a time.

The desktop `flasher/` module is a **flash executor**
([ADR-0038](adr/0038-bootloader-protocols-once-in-core.md)):

```
flasher/
├── mod.rs            # Flasher: parse the hex, pick the driver, run it
├── executor.rs       # Runs a FlashDriver's steps on a serial port
├── serial.rs         # SerialHost: the seam to the OS's serial ports
├── sim_serial.rs     # Test adapter of that seam: a modelled board
├── hardware_smoke.rs # Ignored test: flash a real board
├── commands.rs       # Tauri command handlers
└── types.rs          # Command result payloads
```

What the executor owns is what differs per machine: opening and closing the
port, the DTR/RTS writes of a reset, and finding a Leonardo or Micro again after
its 1200-baud touch, when it comes back as its bootloader on the same port name
or another. The browser has the second executor, over Web Serial (`runFlash` in
`apps/web/src/board/web-serial.ts`).

Both executors keep the same step contract (`crates/microflow-core/src/flasher/driver.rs`):

- A `FlashStep::Transact` discards buffered input first, unless it says
  `keep_input`. A driver keeps the input while it asks a board that was just
  reset again and again, so a late answer to an earlier attempt is not lost.
- `timeout_ms` is one deadline for the whole step, counted from the write.
  Bytes that arrive do not extend it. The drivers' bounds on how long a flash
  can take rest on this.
- A read that comes up short is reported as the bytes that did arrive; the
  driver decides whether that is a retry or the end.

### Firmware images

The StandardFirmata images are embedded in core
(`crates/microflow-core/src/flasher/firmware/`: `uno.hex`, `nano.hex`,
`mega.hex`, `leonardo.hex`, `micro.hex`) and selected by
`firmware::standard_firmata_hex(board)`. Both hosts flash the same bytes.

`apps/web/src-tauri/src/flasher/hex/StandardFirmata/` holds the sketch source of
Microflow's StandardFirmata, for people who flash it by hand from the Arduino
IDE.

### Tests

The drivers are tested against **modelled bootloaders**
(`microflow_core::flasher::sim::SimBootloader`): Optiboot, ATmegaBOOT,
stk500boot and Caterina, each transcribed from the Arduino AVR core. A test
flashes an image and asserts on what ended up in the chip's flash. The desktop
executor is tested through `SimSerial`, a modelled board behind a port. The
browser executor runs against a fake Web Serial port on a fake clock, through
the compiled drivers (`apps/web/src/board/web-serial.flash.wasm.test.ts`). A real
board is checked with the opt-in flash check of the hardware smoke suite:

```bash
# from apps/web
MICROFLOW_HW_PORT=/dev/cu.usbserial-2110 MICROFLOW_HW_FLASH=nano bun run smoke:hardware
```

---

## Threading Model

| Thread | Purpose | Lifetime |
|--------|---------|----------|
| Main (Tauri) | Window events, command handlers | App lifetime |
| `microflow-runtime` (the actor) | Owns the `FlowRuntime`, the open port and the MIDI connections; runs every turn | App lifetime |
| Hardware monitor | Port scans, the board link, probing and flashing | App lifetime |
| Tokio runtime (Tauri's) | Wakeup timers, MQTT clients, the `CloudPerformer` task, the MCP listener, agent CLI subprocesses (owned by `AgentCliRuns`) | App lifetime |

### Agent CLI runs

`AgentCliRuns` (`cli_llm/runs.rs`) starts every agent CLI process and is the one
place one is ended. The webview names each run, and stops it by that name with
`llm_cli_stop`. A stop for a run that is over finds nothing. A stop that
arrives before its run starts is kept (up to 32), and the run is not started.
A run ends when its process exits, when its turn is stopped, when the page
reloads (`on_page_load` → `cli_llm::page_gone`, which also closes the flow tool
session) and when the app quits (`cli_llm::quit`). Ending a run ends its whole
process tree: on unix a process group gets `SIGTERM`, then `SIGKILL` after
`STOP_GRACE` (2 s); on Windows a job object is terminated.

The `FlowRuntime` is `!Send`. It is built inside the actor thread and never
leaves it; everything else talks to it by sending an `ActorMsg` over a channel.
There is no lock around the runtime.

### Shared state

```rust
pub struct AppState {
    pub hardware_service: Arc<Mutex<HardwareService>>,
    pub actor: tokio::sync::mpsc::UnboundedSender<ActorMsg>,
    pub mqtt_manager: MqttManager,
}
```

The flow's MQTT subscriptions are not in `AppState`. The `CloudPerformer` owns
them, and one task applies its reconciles in order.

### Supervision

Every actor turn runs under `catch_unwind`. A panic emits `runtime-crashed` with
a fingerprint (the turn's op and code location, never the message), throws the
runtime away, writes the safe state, and respawns a fresh runtime with the live
session's pins and the last flow. After 3 panics within 60 s the actor halts
until the user restarts it (`runtime_restart`). A halt empties the
`CloudPerformer`'s subscriptions without asking the runtime that panicked, so
the design-tool plugins hear that Studio left. The desktop release profile must
not use `panic = "abort"` ([ADR-0017](adr/0017-wasm-fault-seam.md), amendment).

---

## Development Guide

### Building

```bash
# From apps/web
bun run desktop:dev      # development
bun run desktop:build    # production
```

### Testing

```bash
cargo test --workspace --lib --tests                      # what CI runs
cargo test -p microflow-core --features runtime,cloud     # the engine, with its gated modules
cargo clippy --workspace --all-targets -- -D warnings -W clippy::pedantic
```

`microflow-core`'s `runtime` and `cloud` are non-default features: a bare
`cargo test -p microflow-core` compiles no runtime code.

Hardware behaviour is tested without hardware. The **sim board**
(`microflow_core::firmata::sim`) answers a runtime's bytes the way
StandardFirmata would, and the modelled bootloaders do the same for a flash
([ADR-0030](adr/0030-hardware-tested-at-the-byte-seam.md)). The hardware smoke
suite (`bun run smoke:hardware`, from `apps/web`) runs the real path against a
plugged-in board and is run locally only.

### Logs

Application logs (`log::`) go to stdout and to the OS log directory in every
build:

- macOS: `~/Library/Logs/tech.microflow`
- Windows: `%LOCALAPPDATA%\tech.microflow\logs`

Flow-turn tracing (`tracing::`) is separate and goes to stdout. `RUST_LOG`
filters it; the default shows `microflow_core` at `debug`.

### Code style

- CI runs clippy with `-D warnings -W clippy::pedantic`.
- Follow the node folder layout for new nodes.
- A type the webview reads derives `ts_rs::TS`; `cargo test` regenerates its
  binding in `apps/web/src/lib/bindings/`.

---

## Appendix: Tauri Commands

| Command | Parameters | Description |
|---------|------------|-------------|
| `flow_update` | `flow, brokers?, providers?` | Apply a flow to the runtime; returns when its subscriptions are reconciled |
| `component_call` | `component_id, method, args` | Send a value to a node's port |
| `llm_result` | `source, handle, value` | Return an LLM result to the node that asked |
| `runtime_restart` | — | Leave a crash-loop halt |
| `runtime_status` | — | Whether the runtime is halted, and the crash that halted it |
| `generate_sketch` | `flow, target_id?, credentials?` | Generate an Arduino sketch |
| `check_credentials` | `flow, target_id?, credentials?` | List the credentials the flow's sketch is missing |
| `list_board_targets` | — | Boards a sketch can target |
| `get_available_serial_ports` | — | List detected serial ports |
| `confirm_board_flash` / `decline_board_flash` | `port, vid, pid` | Answer a flash offer |
| `flash_firmware` | `port_name, board_type, hex_content` | Flash a given hex image |
| `flash_standard_firmata` | `port_name, board_type` | Flash StandardFirmata |
| `auto_flash_firmata` | `port_name, vid, pid` | Flash a positively identified board |
| `get_supported_boards` | — | List board ids |
| `mqtt_connect` / `mqtt_disconnect` | broker config / broker id | Connect or disconnect a broker |
| `mqtt_sync_brokers` | broker configs | Make the pool match the settled broker settings; the newest list wins |
| `mqtt_subscribe` / `mqtt_unsubscribe` | broker id, topic | Connection Console subscriptions |
| `mqtt_publish` | broker id, topic, payload, retain | Publish a message |
| `mqtt_status` / `mqtt_all_statuses` / `mqtt_connected_brokers` | — | Connection status |
| `llm_cli_probe` / `llm_cli_models` / `llm_cli_generate` | — | Find and run an agent CLI |
| `llm_cli_stop` | run name | End an Agent CLI run and its process tree |
| `mcp_session_start` / `mcp_session_end` / `mcp_tool_result` | — | The flow tool session for an agent CLI |

---

## Appendix: ComponentValue

```rust
pub enum ComponentValue {
    Bool(bool),
    Number(f64),
    String(String),
    Rgba { r: u8, g: u8, b: u8, a: f64 },
    Array(Vec<ComponentValue>),
}
```

Defined in `crates/microflow-core/src/runtime/value.rs`. Conversion helpers:
`as_bool()`, `as_number()`, `as_u8()`, `is_truthy()`.
