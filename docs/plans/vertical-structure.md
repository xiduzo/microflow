# Vertical codebase structure — proposal

Status: proposal (2026-09-25). Nothing here is applied yet.

Goal: group code by **what it does** (a domain from `CONTEXT.md`), not by **what it is**
(`hooks/`, `stores/`, `lib/`). Code that changes together lives together, and each vertical
exposes one `index.ts` that other verticals import from.

The evidence below comes from a file-level import graph of `apps/web/src` (461 files,
~1,040 cross-module imports).

---

## 1. What is already fine (leave it alone)

| Area | Why it stays |
|---|---|
| `packages/*` (`collab`, `api`, `auth`, `db`, `mqtt`, `env`) | Already one package per domain, with `exports`. This is the pattern the rest should copy. |
| `apps/web/src/components/flow/nodes/<node>/` | Already vertical: component, schema, constants and editors per node. |
| `apps/web/src/session/` | Has a real public barrel (`index.ts`, 21 importers). Only needs cloud and runtime code moved out (see F4). |
| `apps/web/src/lib/ai/` | Cohesive. Only its store and panel sit elsewhere. |
| `apps/web/src/components/ui/` | shadcn design system. A horizontal folder is correct for a design system. |
| `crates/microflow-core` top level (`runtime/`, `codegen/`, `config/`) | Split is driven by feature gates (`runtime`, `cloud`) and ADR-0006. See F7 for the per-node trade-off. |

## 2. Findings

### F1. The node catalog sits inside a UI folder, and 14 modules depend upward into it

`components/flow/nodes/_base/_base.types.ts` and `_REGISTRY.ts` are the generated
**Component Registry** (`ComponentType`, ports, emits, schemas, defaults, adapters). Non-UI
code imports them from inside `components/`:

- `lib/ai/*`, `lib/node-data.ts`, `lib/templates`, `lib/schematic`, `lib/firmata/cloud/cloud-performer.ts`
- `session/flow-update-dispatcher.ts`, `session/use-flow-update-dispatcher.ts`, `session/browser-cloud-probe.ts`
- `stores/node-data.ts`, `stores/node-diagnostics.ts`
- `hooks/use-hotkey-events.ts`, `hooks/use-llm-requests.ts`

`NODE_REGISTRY` also bundles the React component of every node with its metadata. The
non-UI consumers use only `defaults`, `schema` and `adapter`, never `component`. Even so,
importing the registry for a label pulls in all 40 node UIs. `node-context.ts` already had
to work around this, because the hot path pulled in the Firmata wasm glue. Node adapters
also live inside the React file (`import { adapter } from "./figma/figma"`). That
contradicts `docs/steering/TECH.md`, which says an adapter goes in a `host-adapter.ts`
sibling.

### F2. Horizontal buckets that each hold pieces of several domains

- **`hooks/` (14 files):** 12 files have exactly one consumer, and that consumer is a route
  (`routes/flow/$flowId.tsx` or `routes/__root.tsx`). They are the runtime and platform
  wiring for those routes, not reusable hooks.
- **`stores/` (15 files):** each store belongs to one domain: board, cloud, AI, circuit,
  devtools or editor. `stores/app.ts` bundles three unrelated slices: `sidebarOpen` (shell),
  `activeFlowId` (flows) and `hasConnectedArduino`/`showConfetti` (board onboarding).
- **`lib/` (20 loose files + 10 subfolders):** a mix of app-wide infra (`trpc`, `analytics`,
  `uid`) and domain code (`pin.ts`, `flow-colors.ts`, `node-data.ts`, `event-ingest.ts`,
  `pointer-frame.ts`, `auto-layout.ts`, `contribute.ts`).

### F3. `lib/firmata/` is the browser Runtime Host, filed under a protocol name

`flow-reactor`, `runtime-bridge`, `effects-sink`, `dispatch-port`, `cloud/`, `midi/`: this
is the **Runtime Host** from `CONTEXT.md`, not Firmata. It also reaches into five stores
(`board`, `figma`, `llm-provider`, `mqtt-broker`, `node-diagnostics`). The rest of the host
lives elsewhere: `lib/runtime/wasm.ts` (used only by `lib/firmata`), `lib/audio`,
`lib/event-ingest.ts`, and five `hooks/use-*-requests|events`.

### F4. `session/` contains a Cloud Connection sub-domain

`cloud-capabilities`, `cloud-capability-sync`, `browser-cloud-probe` and
`browser-mqtt-test-client` import the LLM, MQTT and Figma stores, `lib/ipc` and `lib/ai`.
Three of the four imports that bypass the session barrel go to these files. The fourth is
`use-flow-nodes`. So the barrel already marks these files as outside the session domain.
`flow-update-dispatcher` and its Tauri/wasm senders are also runtime sync, not session.

### F5. The Arduino sketch export is split, and the dependency is inverted

`lib/codegen/index.ts` imports `components/flow/sketch-code-view.model.ts`: the library
depends on the view model. The feature lives in two places: `lib/codegen/` and five
`components/flow/sketch-*|board-target-picker*|credentials-surface*` pairs. It maps to one
route, `/flow/$flowId/code`.

### F6. Dead code (nothing imports these)

| File | Note |
|---|---|
| `components/flow/nodes/_TYPES.ts` | `NODE_TYPES` is now generated in `_REGISTRY.ts`. This file still has a `satisfies Record<ComponentType, …>` check, so `tsc` still makes you hand-edit it on every new node. Deleting it removes a step from the add-node checklist. |
| `components/flow/credentials-surface.tsx` | The `.model.ts` next to it is used. The component is not. |
| `components/flow/panels/user-panel.tsx` | Contains only `console.log("UserPanel")`. |
| `components/flow/dialogs/edit-flow-dialog.tsx` | Not referenced. |
| `hooks/is-mobile.ts` | `hooks/use-mobile.ts` is the one in use. |

### F7. Adding one node touches about 11 places, across 5 trees

Runtime (`runtime/<category>/<node>.rs` + `mod.rs` + `registry.rs`), config
(`config/<node>.rs` + `mod.rs`), codegen (`codegen/<category>/<node>.rs` + `mod.rs` +
2 match arms), `node-components.json`, and `components/flow/nodes/<node>/`. That is a
horizontal split at node level. Moving it to `nodes/<node>/{config,runtime,codegen}.rs`
with `#[cfg(feature = …)]` per file is possible. But it works against the category modules
and feature gates, so it needs an ADR, not just a folder move. Treat it as optional (Phase 6).

### F8. Repo hygiene

- Files at the repo root that git tracks but that do not belong in the repo: `scratchpad/`
  (11 files: clippy dumps, test output, a Reddit post draft), `conversations.md`,
  `sensor-regression-findings.md`.
- Two ADRs share number 0002: `0002-flow-router-seam.md` and `0002-per-capability-service-traits.md`.
- The "File structure" section of `docs/steering/TECH.md` is out of date. It points at
  `apps/web/src-tauri/src/runtime/{input,output,…}`, which moved to `microflow-core` in ADR-0006.
- `docs/` root mixes current reference docs with dated audits (`AUDIT-2026-05-15.md`,
  `RUNTIME_AUDIT_APRIL_2026.md`, `WASM_BOUNDARY_AUDIT.md`, …). Suggestion: move the dated
  ones to `docs/audits/`.

### F9. The Figma and Penpot plugins are two copies that have drifted apart (low priority)

Same file tree. `use-navigation.ts` and `stores/app.ts` are identical. The message protocol,
`MqttVariableMessenger` and the pages have drifted (80–150 differing lines each). A
`packages/design-plugin-ui` could hold the shared protocol and MQTT messenger. Do this only
if both plugins keep getting features.

---

## 3. Target layout for `apps/web/src`

Vertical names come from `CONTEXT.md` terms and from routes.

```
src/
├── main.tsx · index.css · routeTree.gen.ts
├── routes/        TanStack file routes. Thin: compose verticals, no logic.
│
├── nodes/         Component Catalog, UI half. Public: catalog, NODE_TYPES, NodeContainer
│   ├── catalog.generated.ts      ComponentType, ports, emits, schemas, defaults, adapters. No React.
│   ├── node-types.generated.ts   xyflow NodeTypes map (React)
│   ├── node-data.ts              Node Data Resolver (was lib/node-data.ts)
│   ├── container/                was _base/ + flow/handle.tsx + flow/icon-with-value.tsx
│   ├── live/                     stores/node-data, stores/node-diagnostics
│   └── <node>/                   unchanged; + <node>.adapter.ts where one exists
├── editor/        The canvas: react-flow-canvas, edges/, panels/, sheets/, new-node-dialog,
│                  handle-proximity, collab-cursors, pointer-frame, auto-layout,
│                  stores clipboard/new-node/signal
├── session/       FlowSession, SyncAdapters, ReactFlowBridge, Presence, SessionRegistry
├── runtime/       Runtime Host: was lib/firmata/{flow-reactor,runtime-bridge,effects-sink,
│                  dispatch-port}, lib/runtime (wasm), audio + midi performers, event-ingest
│                  (+ ingest/, format-value), FlowUpdateDispatcher + senders (from session/),
│                  hooks use-component-events/use-audio-requests/use-hotkey-events/
│                  use-node-diagnostics
├── board/         Board: web-serial, board-controller(-core), probe-handshake, stores/board,
│                  lib/pin, hardware/pin.tsx, nav-microcontroller, use-web-serial-board,
│                  use-first-arduino-connection, onboarding slice of stores/app
├── cloud/         LLM provider · MQTT broker · Figma: their stores, lib/firmata/cloud/*,
│                  session cloud-capabilit{y,ies}*, browser-cloud-probe,
│                  browser-mqtt-test-client, components/config/* (connection console),
│                  use-llm-requests
├── ai/            Ask AI: lib/ai/*, stores/ask-ai, components/flow/ask-ai
├── sketch/        Arduino export (/flow/$id/code): lib/codegen (+generated), sketch-code-view*,
│                  sketch-download*, board-target-picker*, credentials-surface.model
├── circuit/       /flow/$id/circuit: lib/schematic, stores/circuit-store
├── flows/         Flow library: components/home/*, create/delete/share dialogs, flow-colors,
│                  templates, use-flow-import-export, flow-switcher, activeFlowId slice
├── community/     components/community/*
├── account/       auth-client, sign-in-form, set-name-dialog, nav-user
├── platform/      Host detection + desktop shell: platform.ts, ipc.ts, wasm-init.ts, is-mac,
│                  use-updater, use-deep-link, download-studio-dialog, nav-download-studio
├── devtools/      microflow-devtools, stores/dev-log, stores/ui-panel, use-backend-logs
├── shell/         App chrome: app-sidebar, nav-main, nav-secondary, states/*, theme-provider,
│                  docs.ts, contribute.ts, sidebar slice of stores/app
├── ui/            Design system: components/ui/*, lib/utils (cn), use-mobile, drag-and-drop provider
└── lib/           App-wide infra only: trpc, analytics, uid, bindings/ (ts-rs output)
```

`hooks/`, `stores/`, `providers/` and `components/` (except `ui/`) disappear. Each vertical
keeps its own hooks, stores and components.

### Dependency rules (what the guard checks)

1. A module outside vertical `X` imports only `X/index.ts`, never `X/<internal>`.
2. `routes/` may import any vertical. No vertical may import `routes/`.
3. `ui/` and `lib/` import no vertical.
4. Only `nodes/` imports `nodes/<node>/*`. Everyone else goes through `nodes/index.ts`
   (catalog + `NODE_TYPES`).
5. `runtime/`, `session/`, `ai/`, `cloud/` and `sketch/` may import `nodes/catalog` but not
   `nodes/node-types` (no React in non-UI code).

### Enforcement

`.oxlintrc.json` exists but is known to be broken, and `eslint-plugin-boundaries` would
bring in ESLint only for this check. This repo already uses guard tests (catalog parity,
codegen parity), so use the same pattern: `src/architecture.test.ts` (bun:test) walks the
import graph and fails on any broken rule, with a clear message. The script used for this
analysis is a working starting point: about 60 lines, with no new dependencies.

---

## 4. Migration: one mechanical PR per phase, as a `gh stack`

Every phase: `git mv` + import rewrite + `bun run check-types` + `bun test` + `bun run build`.
No behavior changes. Each phase ends green.

| Phase | Scope | Risk | Also update |
|---|---|---|---|
| **0 Hygiene** | Delete the 5 dead files (F6). Take `scratchpad/`, `conversations.md` and `sensor-regression-findings.md` out of git. Renumber the duplicate ADR. Fix the TECH.md structure section. | none | add-node checklist memory (`_TYPES.ts` step goes away) |
| **1 Catalog** | Split the generated registry into `catalog.generated.ts` (no React) + `node-types.generated.ts`. Move adapters to `<node>.adapter.ts`. Move `components/flow/nodes` → `src/nodes`. | low | `scripts/codegen-node-registry.ts` (`nodesDir`), 14 docs that reference the path, `ARCHITECTURE.md`, `CONTEXT.md` |
| **2 Cloud** | Create `cloud/` (F4 + cloud stores + `lib/firmata/cloud` + `components/config` + `use-llm-requests`) | low | `docs/` references to `lib/firmata/cloud` |
| **3 Runtime + Board** | `lib/firmata` → `runtime/` + `board/`. Move FlowUpdateDispatcher out of `session/`. Split `stores/app` into three slices. | medium (wasm paths) | `package.json` `build:wasm:*` `--out-dir`, `.gitignore` for `generated/`, `bench` script paths, 18 docs that reference `lib/firmata` |
| **4 Route verticals** | `sketch/`, `circuit/`, `ai/`, `flows/`, `community/`, `account/`, `platform/`, `devtools/`, `shell/`, `ui/`. Fix the `lib/codegen` → view-model inversion (F5). | low | — |
| **5 Guard** | `architecture.test.ts` enforcing §3 rules. Add a short "where does new code go" section to `ARCHITECTURE.md`. | none | `docs/steering/TECH.md` |
| **6 (optional) Rust per-node** | ADR first: colocate `config`/`runtime`/`codegen` per node in `microflow-core` behind `cfg` (F7). | high | catalog parity + codegen parity guards |

Leave `lib/bindings/` where it is. `TS_RS_EXPORT_DIR` pins that path in `.cargo/config.toml`,
`apps/web/src-tauri/.cargo/config.toml` and `Cargo.toml` files, so moving it means Rust
config churn for no structural gain.
