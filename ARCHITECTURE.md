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
        │  apps/web/src-tauri            │                         │  apps/web/src/runtime + board      │
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
| `apps/web` | The Studio: the React + ReactFlow UI in `src/`, one folder per domain (see [Where does new code go?](#where-does-new-code-go)), including the browser runtime host (`src/runtime`, `src/board`); the Tauri desktop shell in `src-tauri`. |
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
TypeScript node catalog and handle types from them, and a **Catalog Parity Guard**
(`apps/web/src-tauri/tests/catalog_parity.rs`) fails the build if the generated
mirror drifts from Rust. Handle rendering is driven from those generated types
(see `NodeHandles`), so a renamed port is a compile error, not a runtime surprise.

## Where does new code go?

`apps/web/src` is split by domain, not by file kind. Each top-level folder is a
**vertical** with its own components, hooks and stores, named after a
[`CONTEXT.md`](CONTEXT.md) term or a route. [ADR-0027]

| Folder | What belongs there |
|---|---|
| `routes/` | TanStack file routes. Thin: they compose verticals. Nothing imports them. |
| `nodes/` | The node library: one folder per node (`<node>.tsx`, `<node>.schema.ts`, optional `<node>.adapter.ts`), shared node chrome in `_base/`, live values and diagnostics in `live/`, and the generated catalog (`*.generated.ts`). |
| `editor/` | The canvas: `react-flow-canvas.tsx`, edges, panels, sheets, the new-node dialog, clipboard, collab cursors, auto-layout. |
| `session/` | FlowSession, SyncAdapters, ReactFlowBridge, Presence, SessionRegistry. |
| `runtime/` | The browser Runtime Host: FlowReactor, RuntimeBridge, EffectsSink, event ingest, the FlowUpdateDispatcher and its senders, audio and MIDI performers. |
| `board/` | The Board: Web Serial, board controller and bring-up, the board and pin store, Arduino onboarding. |
| `cloud/` | MQTT and Figma connections: their stores, the browser CloudPerformer, cloud capabilities, the connection console. |
| `ai/` | Ask AI and the LLM transport it shares with the `Llm` node: provider store, adapters, turn runner, flow tools, MCP bridge. |
| `sketch/` | Arduino sketch export (`/flow/$flowId/code`): codegen, code view, download, board target picker. |
| `circuit/` | The circuit view (`/flow/$flowId/circuit`). |
| `flows/` | The flow library: list, thumbnails, create/delete/share dialogs, templates, import/export, the active flow. |
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
that imports only itself. No vertical imports `routes/`. Only `editor/`, `flows/`
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
- TypeScript: `bun test` (DOM-less unit tests, incl. the architecture guard) +
  `tsc --noEmit`.
- CI runs in `.github/workflows/` (`rust.yml`, `build.yml`, `release.yml`).
- Benchmarks: `criterion` over the engine's hot paths and `k6` over the collab
  room — what each covers, and how to A/B two commits, is in
  [`docs/benchmarks.md`](docs/benchmarks.md).

## Where to read next

- [`CONTEXT.md`](CONTEXT.md) — the domain glossary, kept aligned with the code.
- [`docs/adr/`](docs/adr/) — every architecture decision, with the alternatives
  that were rejected and why.
- [`docs/`](docs/) — runtime audits, handle/pin lifecycle, plugin system, sync.
