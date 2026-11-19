# Architecture

A five-minute map of the codebase. For the domain vocabulary see
[`CONTEXT.md`](CONTEXT.md); for the *why* behind each decision see the numbered
records in [`docs/adr/`](docs/adr/).

## What Microflow is

A visual editor for wiring interactive prototypes to real hardware. Designers drag
**nodes** onto a canvas, connect them, and the flow runs live — driving
microcontrollers over Firmata (serial) and talking to cloud services (LLM, MQTT,
and the Figma and Penpot plugins). It runs as a **desktop app** (Tauri) and in the **browser** (WebAssembly +
Web Serial), and supports real-time **collaboration** (CRDT).

## The one big idea: one engine, two hosts

The live flow runtime is written **once**, in Rust, in `crates/microflow-core`, and
is **sans-IO** — a node never touches the serial port, a clock, or the network. It
takes input and returns an `Effects` record describing what should happen; a
per-platform **Runtime Host** applies those effects. This is the spine of the
codebase and the reason it is testable and portable.

Time in core is the engine clock: the host hands the time in on every call, and a
node reads it with `ctx.now_ms()`. `clippy.toml` in `microflow-core` and
`microflow-runtime-wasm` bans `std::time::Instant` and `SystemTime`, which panic
on wasm.

```
            ┌─────────────────────────  microflow-core (Rust, sans-IO)  ─────────────────────────┐
            │  Component nodes → FlowRouter → Executor → Effects { bytes, events, wakeups, cloud } │
            └───────────▲───────────────────────────────────────────────────────────▲────────────┘
                        │ same engine, two builds                                     │
        ┌───────────────┴───────────────┐                         ┌──────────────────┴────────────────┐
        │  Desktop host (Tauri, native) │                         │  Browser host (wasm + Web Serial)  │
        │  apps/web/src-tauri            │                         │  apps/web/src/runtime + board      │
        │  serial · Tokio timers · cloud │                         │  setTimeout · fetch/WSS · cloud     │
        └────────────────────────────────┘                         └─────────────────────────────────────┘
```

The engine is compiled to WebAssembly for the browser by `crates/microflow-runtime-wasm`
(a thin shim — no logic), so there is **no second implementation** of node behavior.

## Repository layout

| Path | What |
|---|---|
| `crates/microflow-core` | The sans-IO flow engine (`runtime/`) + Arduino code generation (`codegen/`); each node's config, runtime and emitter sit together in `nodes/<node>/` ([ADR-0026](docs/adr/0026-node-code-colocated-per-node.md)). The heart. |
| `crates/microflow-runtime-wasm` | Thin wasm shim exposing the engine to the browser. |
| `crates/microflow-codegen-wasm`, `…-firmata-wasm` | Wasm shims for ahead-of-time sketch codegen / Firmata. |
| `apps/web` | The Studio: the React + ReactFlow UI in `src/`, one folder per domain (see [Where does new code go?](#where-does-new-code-go)), including the browser runtime host (`src/runtime`, `src/board`); the Tauri desktop shell in `src-tauri`. |
| `apps/server` | Collaboration / API backend. The composition root for the database: it binds the `Db` handle once at start-up ([ADR-0034]). |
| `apps/fumadocs` | User documentation site. |
| `apps/figma-plugin`, `apps/penpot-plugin` | The design-tool plugins. Each keeps only a sandbox adapter (reading and writing its tool's variables or tokens), host glue and its own views. |
| `packages/design-bridge` | The design-tool bridge: the MQTT protocol (topics, wire IDs, value coercion, the Bridge ID rule) plus the plugin side: the bridge engine, the plugin bridge session (settings, the broker connection over mqtt.js, presence, polling), UI stores and sandbox routing. Used by both plugins and by Studio's web code; mirrored in Rust by `crates/microflow-core/src/design_bridge.rs`. Both sides are checked against `fixtures/protocol.json`. [ADR-0028], [ADR-0040] |
| `packages/*` | The other shared TS libs: `collab` (Yjs sync; the room is the only path between two clients, tabs of one browser included), `api` (tRPC), `auth`, `db`, `env`, `config`. |

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
- **Host input** — a key or a MIDI message a host read off a device. The host
  hands it to core, which picks the listening nodes; hosts keep the device I/O.
  [ADR-0037]
- **Flash driver / Flash executor** — each bootloader protocol lives once in core
  as a step machine with no I/O; each host runs the steps on its own serial
  transport. A `Transact` step has one deadline, counted from its write; bytes
  that arrive do not extend it. [ADR-0038]
- **CloudPerformer** — each host's cloud half: `perform()` for a turn's cloud
  requests and `reconcile()` for the flow's MQTT subscriptions, which it owns.
  Host-free and unit-testable on both platforms. Both hosts connect from the
  **Settled broker settings** (`cloud/mqtt-broker.ts`): a typed field joins
  them 500 ms after the last keystroke. [ADR-0009], [ADR-0035], [ADR-0036]
- **Wire-interface contract** — a node's Port/Emit handles are declared once in
  Rust and **generated** into the TypeScript UI, with a parity guard that fails CI
  on drift. Single source of truth. [ADR-0007]
- **Node config resolution** — the shape the editor writes into a node's `data`
  is the contract; the runtime and the sketch emitter both read it through
  `config::resolve`, and a `data` that cannot be read stops the node and refuses
  the sketch. [ADR-0033]
- **Live Handle Set** — the Ports and Emits a node offers for its current
  settings, stated once per node as a Handle Rule and read by the canvas, the
  connection check, Ask AI and the session's handle pruning. [ADR-0032]
- **FlowSession / SyncAdapter** — the editing + persistence/collab seam (local,
  cloud, preview). [ADR-0003]
- **ReactFlowBridge** — reconciles the CRDT document with the ReactFlow canvas.
  [ADR-0004]
- **FlowUpdateDispatcher** — ships canvas changes to the runtime. [ADR-0005]
- **Design-tool bridge protocol** — one MQTT protocol between Studio and the Figma
  and Penpot plugins, defined once per language (`packages/design-bridge`,
  `design_bridge.rs`) and checked against one shared fixture. A plugin runs it
  through one plugin bridge session. [ADR-0028], [ADR-0040]
- **Flow File** — the JSON a flow is exported to and imported from. Its decoder
  is a load boundary: a file is read as a stored flow with the same defect would
  be, with notices, and refused only when it cannot be a flow. Stored edges are
  read through the same `decodeEdge` (`packages/collab/src/schema.ts`). [ADR-0041]
- **Agent CLI Port** — the webview's seam to the desktop host that runs an agent
  CLI and serves its flow tool session; a Tauri adapter and a scripted one. The
  desktop host owns every **Agent CLI run** (`AgentCliRuns`,
  `apps/web/src-tauri/src/cli_llm/runs.rs`) and ends its whole process tree when the turn
  is stopped, the page reloads or the app quits. [ADR-0024], [ADR-0039]
- **Db handle** — the server packages' seam to Postgres, bound once by the
  composition root; tests bind an in-process Postgres with the real migrations.
  The Flow library under the tRPC routers owns the flow row and its documents.
  [ADR-0034]

[ADR-0001]: docs/adr/0001-component-trait-flow-separation.md
[ADR-0002]: docs/adr/0002-flow-router-seam.md
[ADR-0003]: docs/adr/0003-flow-session-seam.md
[ADR-0004]: docs/adr/0004-react-flow-bridge.md
[ADR-0005]: docs/adr/0005-flow-update-dispatcher.md
[ADR-0006]: docs/adr/0006-rehost-runtime-on-core.md
[ADR-0007]: docs/adr/0007-node-wire-interface-emit-contract.md
[ADR-0008]: docs/adr/0008-effects-apply-policy.md
[ADR-0009]: docs/adr/0009-cloud-sans-io-capability.md
[ADR-0024]: docs/adr/0024-flow-tools-over-mcp-for-agent-clis.md
[ADR-0028]: docs/adr/0028-design-tool-bridge-protocol.md
[ADR-0032]: docs/adr/0032-live-handle-set-and-handle-pruning.md
[ADR-0033]: docs/adr/0033-one-node-config-resolution.md
[ADR-0034]: docs/adr/0034-database-handle-bound-at-the-composition-root.md
[ADR-0035]: docs/adr/0035-desktop-cloud-performer-owns-subscriptions.md
[ADR-0036]: docs/adr/0036-browser-host-owns-subscription-state.md
[ADR-0037]: docs/adr/0037-core-owns-host-input-fan-out.md
[ADR-0038]: docs/adr/0038-bootloader-protocols-once-in-core.md
[ADR-0039]: docs/adr/0039-agent-cli-port.md
[ADR-0040]: docs/adr/0040-plugin-bridge-session.md
[ADR-0041]: docs/adr/0041-flow-file-is-a-load-boundary.md

## Single source of truth

The node catalog (`apps/web/node-components.json`) plus the Rust `ports()`/`emits()`
declarations are the *only* place node identity lives. A build step generates the
TypeScript node catalog and handle types from them, and a **Catalog Parity Guard**
(`apps/web/src-tauri/tests/catalog_parity.rs`) fails the build if the generated
mirror drifts from Rust. A node's settings are held the same way: the shape the
editor writes into `data` is the contract, the runtime and the sketch emitter both
read it through `config::resolve`, and the guard feeds every entry's editor
defaults and enum options through that step ([ADR-0033]). Each node states the
handles it offers once, as a Handle Rule typed against the generated types
(`nodes/<node>/<node>.handles.ts`), so a renamed port is a compile error, not a
runtime surprise. The canvas, the connection check, Ask AI and the session all
read the resulting Live Handle Set (`nodes/handles.ts`). [ADR-0032]

## Where does new code go?

`apps/web/src` is split by domain, not by file kind. Each top-level folder is a
**vertical** with its own components, hooks and stores, named after a
[`CONTEXT.md`](CONTEXT.md) term or a route. [ADR-0027]

| Folder | What belongs there |
|---|---|
| `routes/` | TanStack file routes. Thin: they compose verticals. Nothing imports them. |
| `nodes/` | The node library: one folder per node (`<node>.tsx`, `<node>.schema.ts`, `<node>.handles.ts`, optional `<node>.adapter.ts`), shared node chrome in `_base/`, live values and diagnostics in `live/`, the Live Handle Set (`handles.ts`) and the generated catalog (`*.generated.ts`). |
| `editor/` | The canvas: `react-flow-canvas.tsx`, edges, panels, sheets, the new-node dialog, clipboard, collab cursors, auto-layout. |
| `session/` | FlowSession, SyncAdapters, ReactFlowBridge, Presence, SessionRegistry, handle and dangling-edge pruning. |
| `runtime/` | The browser Runtime Host: FlowReactor, RuntimeBridge, EffectsSink, event ingest, the FlowUpdateDispatcher and its senders, audio and MIDI performers. |
| `board/` | The Board: Web Serial, board controller and bring-up, the board and pin store, Arduino onboarding. |
| `cloud/` | MQTT and design-tool bridge connections: their stores (including the Bridge ID), the browser CloudPerformer, cloud capabilities, the connection console. |
| `ai/` | Ask AI and the LLM transport it shares with the `Llm` node: provider store, adapters, turn runner, flow tools, MCP bridge, and the Agent CLI Port to the desktop host. |
| `sketch/` | Arduino sketch export (`/flow/$flowId/code`): codegen, code view, download, board target picker. |
| `circuit/` | The circuit view (`/flow/$flowId/circuit`). |
| `flows/` | The flow library: list, thumbnails, create/delete/share dialogs, templates (signed in, each choice is a new flow in the account), the Flow File codec with import and export, the active flow. |
| `community/` | Community flows. |
| `account/` | Auth client, sign-in, display name, user menu. |
| `devtools/` | The Microflow devtools drawer and its logs. |
| `shell/` | App chrome: sidebar, navigation, contribute links, and the temporary `microflow:app` localStorage migration. |
| `platform/` | Host detection and the desktop shell: `platform.ts`, Tauri `ipc.ts`, updater, deep links. |
| `ui/` | The design system: shadcn primitives, empty/error/loading states, theme provider, `cn` (`utils.ts`). |
| `lib/` | App-wide infrastructure with no domain: tRPC client, analytics, ids, wasm loader, ts-rs `bindings/`. |

**Public surfaces.** Each vertical lists the files other verticals may import in
`apps/web/scripts/architecture/verticals.ts`, like the `exports` map of a
`package.json`. Every other file is internal. There are no `index.ts` barrels
(`session/index.ts` is the one public entry that happens to be one), and `ui/` and
`lib/` are fully public. `lib/`, `ui/` and `platform/` form an infrastructure layer
that imports only itself. No vertical imports `routes/`. `session/` imports only
the infrastructure layer (`mayImport` in `verticals.ts`); what it needs from
another vertical it is handed at app start by `src/app-wiring.ts` (`wireApp()`).
Only `editor/`, `flows/`
and `nodes/` may load the React node map (`nodes/node-types.generated.ts`); all
other code reads `nodes/catalog.generated.ts`.

**The guard.** `bun test src/architecture.test.ts` (from `apps/web`; CI runs it with
the rest of `bun test`) fails on an import that breaks these rules, and on a new
top-level folder that `verticals.ts` does not list. The same rules are oxlint errors
(`microflow/vertical-boundaries`, plus `microflow/cross-vertical-alias`: cross into
another vertical through `@/`, and `import/no-cycle`), so the editor flags them as
you type. Lint needs Node 22.18 or later. To use another vertical's
internal file, add it to that vertical's `public` list, and treat that as a
decision for review. Often the better fix is to move the code to where it is used.

[ADR-0027]: docs/adr/0027-web-app-domain-verticals.md

## Testing & CI

- Rust: `cargo test` across the crates (engine, wasm, desktop) — incl. the parity
  guard; clippy-clean.
- TypeScript: `bun test` (DOM-less unit tests, incl. the architecture guard; the
  server packages run on an in-process Postgres, so no database is needed) +
  `tsc --noEmit`.
- CI runs in `.github/workflows/` (`rust.yml`, `typescript.yml`, `build.yml`,
  `release.yml`). `typescript.yml` runs `bun test`, oxlint and `check-types`, and
  builds the Figma and Penpot plugins.
- Benchmarks: `criterion` over the engine's hot paths and `k6` over the collab
  room — what each covers, and how to A/B two commits, is in
  [`docs/benchmarks.md`](docs/benchmarks.md).

## Where to read next

- [`CONTEXT.md`](CONTEXT.md) — the domain glossary, kept aligned with the code.
- [`docs/adr/`](docs/adr/) — every architecture decision, with the alternatives
  that were rejected and why.
- [`docs/`](docs/) — runtime audits, handle/pin lifecycle, plugin system, sync.
