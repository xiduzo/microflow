# ADR-0027 — The web app is organised by domain vertical, each with explicit public entry files

- **Status:** accepted — implemented (2026-09-25)
- **Date:** 2026-09-25
- **Deciders:** sander
- **Plan:** [`docs/plans/vertical-structure.md`](../plans/vertical-structure.md) (the
  findings, the target layout and the migration phases)

## Context

`apps/web/src` was split by what a file *is*: `components/`, `hooks/`, `stores/`,
`providers/`, `lib/`. A file-level import graph of the tree (461 files, about 1,040
cross-module imports) showed what that split cost:

- **The node catalog sat inside a UI folder.** The generated Component Registry
  (`components/flow/nodes/_base/_base.types.ts` and `_REGISTRY.ts`) was imported by
  14 non-UI modules: Ask AI, templates, the schematic, the browser cloud performer,
  the session's FlowUpdateDispatcher, two stores and two hooks. `NODE_REGISTRY`
  bundled every node's React component with its metadata, so reading one label
  loaded 40 node UIs. `node-context.ts` already carried a workaround because the
  Firmata wasm glue arrived on a hot path that way.
- **Each bucket held pieces of several domains.** 12 of the 14 files in `hooks/`
  had exactly one consumer, and it was a route. Each of the 15 stores belonged to
  one domain, and `stores/app.ts` bundled three unrelated slices: the sidebar, the
  active flow and the Arduino onboarding. `lib/` mixed app-wide infrastructure
  (`trpc`, `analytics`, `uid`) with domain code (`pin.ts`, `flow-colors.ts`,
  `node-data.ts`, `event-ingest.ts`).
- **Domains were filed under a mechanism, or split in two.** The browser Runtime
  Host lived in `lib/firmata/` and reached into five stores. The Cloud Connection
  code sat in `session/`. The Arduino sketch export was split between `lib/codegen/`
  and five `components/flow/sketch-*` files, and `lib/codegen` imported a view
  model from `components/`: the library depended on its UI.
- **Nothing said what one folder may use of another.** `session/` was the only
  folder with a public surface (its `index.ts`), and four imports bypassed even
  that.

One feature change touched three or four top-level folders, and the tree did not
tell a reader where the Runtime Host, the Board or Ask AI lived.

## Decision

**`apps/web/src` is organised by domain vertical. Each top-level folder is one
domain, named after a [`CONTEXT.md`](../../CONTEXT.md) term or the route it serves,
and keeps its own components, hooks and stores.**

```text
routes/                                      TanStack file routes; compose the verticals
nodes/  editor/  session/  runtime/  board/  cloud/  ai/
sketch/  circuit/  flows/  community/  account/  devtools/  shell/   feature verticals
platform/  ui/  lib/                         infrastructure
```

[`ARCHITECTURE.md`](../../ARCHITECTURE.md) § "Where does new code go?" says what
belongs in each one.

### Public entry files, not barrels

Each vertical declares the files that other verticals may import, in the
`VERTICALS` table in `apps/web/scripts/architecture/verticals.ts`. The table reads
like the `exports` map of a `package.json`: each entry is a path relative to the
vertical, and `*` matches any run of characters, `/` included. A file that no entry
matches is internal to its vertical.

- `session/` keeps its `index.ts`, which was already its public surface.
- `ui/` and `lib/` are fully public (`"*"`). A design system and app-wide helpers
  have no internals worth hiding.
- Inside a vertical, any file may import any other.

### Five rules, one guard

`apps/web/src/architecture.test.ts` (bun:test) builds the import graph of `src/` with
the TypeScript compiler API and fails on any import that breaks a rule. Every import
form counts: static, `export … from`, dynamic `import()`, side-effect `import "…"`,
and `mock.module("…")` in tests. Files under a `generated/` folder are not checked
as importers.

1. **public-surface** — an import from one vertical into another targets a file in
   the other vertical's public list. `import type` counts too: type coupling is still
   coupling.
2. **routes-are-top** — no vertical imports `routes/` or a root file (`main.tsx`,
   `routeTree.gen.ts`). Routes compose the verticals; nothing composes the routes.
3. **infra-layer** — `lib/`, `ui/` and `platform/` import only each other.
   Infrastructure never depends on a domain.
4. **restricted-file** — `nodes/node-types.generated.ts` (`NODE_TYPES`, the React
   map that loads every node's UI) is imported at runtime only by `editor/`,
   `flows/` and `nodes/` itself. Non-UI code reads `nodes/catalog.generated.ts`
   (`NODE_CATALOG`: defaults, schema and host adapter per type, no React). A
   type-only import is exempt from this rule, and only from this one, because the
   compiler erases it.
5. **unknown-vertical** — every folder and file directly in `src/` is listed in
   `VERTICALS` or as a root file. New code has to pick a home.

The guard lives beside the code it checks:

| File | Role |
|---|---|
| `apps/web/src/architecture.test.ts` | Runs the engine over the real tree, and tests each rule on small in-memory fixtures. |
| `apps/web/scripts/architecture/verticals.ts` | The `VERTICALS` table and the root files: the only file to edit when a surface changes. |
| `apps/web/scripts/architecture/engine.ts` | The rules. Pure: an import graph in, violations out. |
| `apps/web/scripts/architecture/import-graph.ts` | Parses `src/` into the import graph. |
| `apps/web/scripts/architecture/resolve.ts` | Resolves a specifier, including the `@/` alias. Dependency-free, so the lint plugin can load it. |
| `apps/web/scripts/architecture/oxlint-plugin.mjs` | The same engine and table as oxlint rules, for the editor and `bunx oxlint`. |
| `apps/web/scripts/architecture/derive-public-surface.ts` | Prints each vertical's current surface and the cross-vertical dependency counts and cycles. |

Run the guard with `bun test src/architecture.test.ts` from `apps/web`. CI runs it
as part of `bun test`. A failure names the importing file, the specifier, the
resolved target, the rule, and the fix. No dependency was added for it.

The same rules run as lint errors, so a broken boundary shows up in the editor and
not only in the test run. `.oxlintrc.json` loads `oxlint-plugin.mjs` for
`apps/web/src` with three rules:

- `microflow/vertical-boundaries`: the five rules above, reported on the import.
- `microflow/cross-vertical-alias`: an import into another vertical uses the `@/`
  alias, never `../`, so every crossing is visible in the import list. It has an
  autofix.
- `import/no-cycle`: no module cycles. This is the ESM TDZ failure that ruled out
  barrels.

The plugin imports the TypeScript engine directly through Node's type stripping, so
lint needs Node 22.18 or later (CI pins Node 24 in the lint job). `bunx oxlint
--tsconfig apps/web/tsconfig.json` (CI, and `bun run check`) passes the tsconfig so
that `no-cycle` resolves the `@/` alias.

## Rejected

- **An `index.ts` barrel per vertical**, which is what the plan first proposed. A
  barrel makes an import of one hook evaluate the whole vertical. The lazy route
  chunks (`routes/flow/$flowId/code.lazy.tsx`, `circuit.lazy.tsx`) would then pull in
  everything their vertical's barrel touches. Barrels are also the usual source of
  ESM import cycles, which fail at startup with a TDZ error instead of at compile
  time. A list of entry files gives the same boundary without either problem, for
  one line in `verticals.ts` per public file.
- **`eslint-plugin-boundaries`.** It checks this kind of rule, but it needs ESLint,
  which the repo does not use. The linter is oxlint. ESLint only for this check means
  a second linter to configure, run in CI and keep in step. oxlint's JS plugins run
  the guard's own engine instead, so the test and the lint rule cannot disagree.
- **`no-restricted-imports` patterns generated per vertical.** They would copy the
  table into a second format, and they cannot see relative imports that cross a
  vertical.
- **Keep the horizontal split and only move the node catalog out of
  `components/`.** That removes the worst upward dependency. It leaves `hooks/`,
  `stores/` and `lib/` holding pieces of every domain, and nothing stops the next
  upward import.

## Consequences

- **New code goes into the vertical whose domain it serves**, next to the code it
  changes with. A hook or a store that one vertical uses lives in that vertical.
  `lib/` is only for app-wide infrastructure with no domain; a helper that names a
  `CONTEXT.md` term belongs to that term's vertical.
- **Widening a public surface is a conscious decision.** When you need another
  vertical's internal file, you either use one of its public files or add the file to
  its `public` list. The second choice shows up in review as a diff to
  `verticals.ts`. Often the better move is to put the code in the vertical that uses
  it.
- **A new vertical is a new folder plus a `VERTICALS` entry.** The unknown-vertical
  rule fails until both exist. Name it after a `CONTEXT.md` term or its route, and add
  its line to `ARCHITECTURE.md`.
- **Cycles between verticals are allowed**, as long as each edge goes through a
  public file. The guard constrains which files cross a boundary, not the direction.
  `derive-public-surface.ts` prints the cycles so they stay visible.
- **Adding a node needs no hand-edited registry.** Codegen writes
  `nodes/component-types.generated.ts`, `nodes/catalog.generated.ts` and
  `nodes/node-types.generated.ts`, and finds a node's host adapter by the presence of
  `nodes/<node>/<node>.adapter.ts`.
- **The LLM provider store, the Llm node's transport (`llm-client.ts`) and
  `use-llm-requests.ts` live in `ai/`**, next to `ai/adapter.ts`, which Ask AI and
  the provider transport share
  ([ADR-0021](0021-one-llm-transport-in-the-webview.md)). `cloud/` imports `ai/`;
  `ai/` does not import `cloud/`.
- **`lib/bindings/` stays where it is.** `TS_RS_EXPORT_DIR` pins the path in
  `.cargo/config.toml` and `apps/web/src-tauri/.cargo/config.toml`, so moving it
  would be Rust config churn for no structural gain.
- **`shell/legacy-app-store.ts` is temporary.** It moves the old `microflow:app`
  localStorage entry into the three stores that replaced `stores/app.ts`
  (`shell/sidebar.ts`, `flows/active-flow.ts`, `board/arduino-onboarding.ts`), so a
  returning user keeps their sidebar, active flow and onboarding state. Delete it
  once returning users have been migrated.
