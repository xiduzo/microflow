# Architecture

A five-minute map of the codebase. For the domain vocabulary see
[`CONTEXT.md`](CONTEXT.md); for the *why* behind each decision see the numbered
records in [`docs/adr/`](docs/adr/).

## What Microflow is

A visual editor for wiring interactive prototypes to real hardware. Designers drag
**nodes** onto a canvas, connect them, and the flow runs live — driving
microcontrollers over Firmata (serial) and talking to cloud services (LLM, MQTT,
Figma). It runs as a **desktop app** (Tauri) and in the **browser** (WebAssembly +
Web Serial), and supports real-time **collaboration** (CRDT).

## The one big idea: one engine, two hosts

The live flow runtime is written **once**, in Rust, in `crates/microflow-core`, and
is **sans-IO** — a node never touches the serial port, a clock, or the network. It
takes input and returns an `Effects` record describing what should happen; a
per-platform **Runtime Host** applies those effects. This is the spine of the
codebase and the reason it is testable and portable.

```
            ┌─────────────────────────  microflow-core (Rust, sans-IO)  ─────────────────────────┐
            │  Component nodes → FlowRouter → Executor → Effects { bytes, events, wakeups, cloud } │
            └───────────▲───────────────────────────────────────────────────────────▲────────────┘
                        │ same engine, two builds                                     │
        ┌───────────────┴───────────────┐                         ┌──────────────────┴────────────────┐
        │  Desktop host (Tauri, native) │                         │  Browser host (wasm + Web Serial)  │
        │  apps/web/src-tauri            │                         │  apps/web/src/lib/firmata          │
        │  serial · Tokio timers · cloud │                         │  setTimeout · fetch/WSS · cloud     │
        └────────────────────────────────┘                         └─────────────────────────────────────┘
```

The engine is compiled to WebAssembly for the browser by `crates/microflow-runtime-wasm`
(a thin shim — no logic), so there is **no second implementation** of node behavior.

## Repository layout

| Path | What |
|---|---|
| `crates/microflow-core` | The sans-IO flow engine + Arduino code generation. The heart. |
| `crates/microflow-runtime-wasm` | Thin wasm shim exposing the engine to the browser. |
| `crates/microflow-codegen-wasm`, `…-firmata-wasm` | Wasm shims for ahead-of-time sketch codegen / Firmata. |
| `apps/web` | The Studio: React + ReactFlow UI, the Tauri desktop shell (`src-tauri`), and the browser runtime host (`src/lib/firmata`). |
| `apps/server` | Collaboration / API backend. |
| `apps/fumadocs` | User documentation site. |
| `apps/figma-plugin`, `apps/penpot-plugin` | Design-tool integrations. |
| `packages/*` | Shared TS libs: `collab` (Yjs sync), `api` (tRPC), `auth`, `db`, `mqtt`, `env`, `config`. |

## Key seams (and where they're decided)

Each is a deliberate interface with its own decision record:

- **Component trait** — splits a node's edge inputs (**Port**), self-scheduled
  events, and hardware callbacks. [ADR-0001]
- **FlowRouter** — turns one emitted event into the list of deliveries; the only
  place that knows the edge layout. [ADR-0002]
- **Effects / EffectsSink** — the side-effect record + the *canonical order* a host
  applies it in. [ADR-0006], [ADR-0008]
- **Runtime Host** — the per-platform adapter (desktop actor / browser reactor)
  that owns IO and applies `Effects`. [ADR-0006]
- **CloudPerformer** — the cloud half (LLM/MQTT/Figma) behind one `perform()`
  interface, host-free and unit-testable, on both platforms. [ADR-0009]
- **Wire-interface contract** — a node's Port/Emit handles are declared once in
  Rust and **generated** into the TypeScript UI, with a parity guard that fails CI
  on drift. Single source of truth. [ADR-0007]
- **FlowSession / SyncAdapter** — the editing + persistence/collab seam (local,
  cloud, preview). [ADR-0003]
- **ReactFlowBridge** — reconciles the CRDT document with the ReactFlow canvas.
  [ADR-0004]
- **FlowUpdateDispatcher** — ships canvas changes to the runtime. [ADR-0005]

[ADR-0001]: docs/adr/0001-component-trait-flow-separation.md
[ADR-0002]: docs/adr/0002-flow-router-seam.md
[ADR-0003]: docs/adr/0003-flow-session-seam.md
[ADR-0004]: docs/adr/0004-react-flow-bridge.md
[ADR-0005]: docs/adr/0005-flow-update-dispatcher.md
[ADR-0006]: docs/adr/0006-rehost-runtime-on-core.md
[ADR-0007]: docs/adr/0007-node-wire-interface-emit-contract.md
[ADR-0008]: docs/adr/0008-effects-apply-policy.md
[ADR-0009]: docs/adr/0009-cloud-sans-io-capability.md

## Single source of truth

The node catalog (`apps/web/node-components.json`) plus the Rust `ports()`/`emits()`
declarations are the *only* place node identity lives. A build step generates the
TypeScript registry and handle types from them, and a **Catalog Parity Guard**
(`apps/web/src-tauri/tests/catalog_parity.rs`) fails the build if the generated
mirror drifts from Rust. Handle rendering is driven from those generated types
(see `NodeHandles`), so a renamed port is a compile error, not a runtime surprise.

## Testing & CI

- Rust: `cargo test` across the crates (engine, wasm, desktop) — incl. the parity
  guard; clippy-clean.
- TypeScript: `bun test` (DOM-less unit tests) + `tsc --noEmit`.
- CI runs in `.github/workflows/` (`rust.yml`, `build.yml`, `release.yml`).

## Where to read next

- [`CONTEXT.md`](CONTEXT.md) — the domain glossary, kept aligned with the code.
- [`docs/adr/`](docs/adr/) — every architecture decision, with the alternatives
  that were rejected and why.
- [`docs/`](docs/) — runtime audits, handle/pin lifecycle, plugin system, sync.
