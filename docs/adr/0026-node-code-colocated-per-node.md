# ADR-0026 — A node's Rust code lives in one directory; dispatch stays central

- **Status:** accepted (2026-09-25)
- **Date:** 2026-09-25
- **Deciders:** sander
- **Resolves:** the category-taxonomy debt noted in
  [ADR-0006](0006-rehost-runtime-on-core.md) ("the runtime and codegen category
  trees diverged")
- **Keeps:** [ADR-0012](0012-component-trait-plumbing-stays-explicit.md)
  (explicit plumbing, no auto-registration)

> **Decision:** each node's Rust code in `microflow-core` lives in one directory,
> `crates/microflow-core/src/nodes/<node>/`, as `config.rs`, `runtime.rs` and
> `codegen.rs`. A node has only the files it needs. `nodes/<node>/mod.rs` puts
> each layer behind the same `#[cfg(feature = …)]` gate it had before. The
> category directories (`runtime/input/`, `codegen/control/`, …) are gone. The
> central dispatch tables (`register_all`, `emit_node`, `output_expression`,
> `parity.rs::classify`) stay central and explicit. They now point at
> `nodes::<node>::{runtime,codegen}`.

## Context

A node in `microflow-core` has up to three Rust layers:

- a **config** (ungated POD struct, shared by interpret and emit — ADR-0006's
  single-source work);
- a **runtime** `Component` impl (behind `runtime`; `cloud` for the cloud nodes,
  `js` for `Function`);
- a **codegen** emitter (ungated, so `microflow-codegen-wasm` stays lean).

Before this ADR, the three layers lived in three separate trees, and each tree
was sorted a different way:

| Layer   | Path                            | Grouped by                                                          |
| ------- | ------------------------------- | ------------------------------------------------------------------- |
| config  | `config/<node>.rs`              | flat, on purpose, *because* the two trees below disagree            |
| runtime | `runtime/<category>/<node>.rs`  | `input`, `output`, `control`, `generator`, `transformation`, `cloud` |
| codegen | `codegen/<category>/<node>.rs`  | same names, **different members**                                   |

The two category trees did not agree. `Constant` and `Interval` were in
`runtime/generator/` but in `codegen/control/`. `Monitor` was in
`runtime/output/` but in `codegen/cloud/`. ADR-0006 recorded this as debt. The
config tree stayed flat only because neither category tree could be its parent.

Adding one node therefore meant about 11 edits across 5 trees (finding F7 of the
vertical-structure review). In the Rust crate:

1. `config/<node>.rs` (new) and 2. its line in `config/mod.rs`;
3. `runtime/<category>/<node>.rs` (new), 4. its line in the category `mod.rs`,
   and 5. a line in `runtime/registry.rs::register_all`;
6. `codegen/<category>/<node>.rs` (new), 7. its line in the category `mod.rs`,
   and 8–9. two arms in `codegen/mod.rs` (`emit_node`, `output_expression`);

then 10. `apps/web/node-components.json` and 11. the TS node folder. (The
`parity.rs::classify` arm adds one more on top of that count.) To read one node,
you open three files in three trees, and for two of them you must first work out
which category that tree uses. The parity question, "does the emitted C++ do
what the runtime does?", is about one node. But its two halves were far apart.

F7 called per-node colocation "possible, but it works against the category
modules and feature gates". We checked the feature-gate part, and it does not
hold up. A cargo feature gates a **`mod` item**. It does not care where the
file is. `#[cfg(feature = "cloud")] pub mod cloud;` on a category directory and
`#[cfg(feature = "cloud")] pub mod runtime;` on one node's runtime file are the
same mechanism. The gates used today are per node, and they map one to one:
`runtime` for 29 nodes, `cloud` for 5 (`Mqtt`, `Llm`, `Figma`, `Midi`, `Music`),
and `js` for 1 (`Function`). Config and codegen stay ungated.

## Decision

**D1: one directory per node, one file per layer.**

```text
crates/microflow-core/src/nodes/
├── mod.rs                 # `pub(crate) mod <node>;` × 35 — the node index
├── led/
│   ├── mod.rs             # pub(crate) mod codegen; pub(crate) mod config; #[cfg(feature = "runtime")] pub(crate) mod runtime;
│   ├── config.rs          # LedConfig — ungated, shared by interpret + emit
│   ├── runtime.rs         # Led: Component — behind `runtime`
│   └── codegen.rs         # emit / pin — ungated
├── mqtt/                  # runtime.rs behind `cloud`
├── function/              # runtime.rs behind `js`; no config.rs
├── note/                  # runtime.rs only
└── …
```

A node has only the files it needs. `Note` has only a runtime. `Pn532` and
`Music` have no emitter. `Sensor`, `Counter`, `Matrix`, `Monitor` and `Function`
have no shared config. `nodes/<node>/mod.rs` is the one place that says which
layers exist and which feature gates each one. Inside the vertical, the layers
reach each other through `super::config`. Shared infrastructure is always
reached through `crate::runtime::…` / `crate::codegen::…`.

**D2: the category directories go; the category stays a label.** The
`runtime/{control,generator,input,output,transformation}/` and
`codegen/{control,generator,input,output,transformation}/` directories are
deleted, and so are the per-node files in `config/`. No Rust path depends on a
category any more. The two taxonomies cannot disagree, because there is only
one taxonomy: the node's name. `impls[].category` in `node-components.json` is
now a catalog label only. No Rust module path follows from it.

The files that stay are those that are shared by more than one node:

- `runtime/{component,context,router,registry,value,wiring,board,reconcile,subscriptions,pin_mode,error}.rs`: the engine;
- `runtime/cloud.rs`: the sans-IO cloud test support (`recorded_cloud_requests`,
  `with_test_ctx`) used by the five cloud nodes, behind `cloud`;
- `codegen/{emit,wire,board,validate,parity,placeholder,credentials}.rs`: the
  generator;
- `codegen/cloud/transport.rs`: the WiFi + MQTT bring-up that the `Figma` and
  `Monitor` emitters both use;
- `config/serde_utils.rs`: the pin string-or-number serde helpers used by the
  configs.

The prose that used to be in the category `mod.rs` files (the codegen
non-blocking-timer invariant, the consumer-and-producer rule for transformation
nodes) moves to `nodes/mod.rs`, because it describes how node emitters are
written.

**D3: dispatch stays central and explicit (ADR-0012).** The per-node lines in
`ComponentRegistry::register_all`, `codegen::emit_node`,
`codegen::output_expression`, the `validate.rs` pin tables, and
`parity.rs::classify` stay where they were, one explicit line each. They now
name `nodes::<node>::runtime::<Impl>` or `nodes::<node>::codegen::emit`.
`grep '"Led"'` still lists every place the system knows about `Led`.

**D4: no re-export shims.** The old paths (`crate::runtime::input::button`,
`crate::codegen::output::led`, `crate::config::smooth`) are removed, not
aliased. Nothing outside `microflow-core` used them: the desktop crate, the
three wasm crates, the benches and the golden tests only use shared
infrastructure (`runtime::{FlowRuntime, ComponentRegistry, subscriptions, …}`,
`codegen::{generate, board, credentials}`). Two paths for one type is the kind of
drift this change removes.

### Cost of adding a node, before and after

The F7 count, which does not include the `classify` arm:

| Step                          | Before                                   | After                               |
| ----------------------------- | ---------------------------------------- | ----------------------------------- |
| node code (config/runtime/codegen) | 3 new files in 3 trees, 2 category choices | 1 new directory (`nodes/<node>/`)  |
| module registration           | `config/mod.rs` + 2 category `mod.rs`    | 1 line in `nodes/mod.rs`            |
| runtime registration          | `register_all`                           | `register_all`                      |
| codegen dispatch              | `emit_node` + `output_expression`        | `emit_node` + `output_expression`   |
| catalog + TS                  | `node-components.json` + TS node folder  | unchanged                           |
| **touch points**              | **11, across 5 trees**                   | **7, across 3 trees**               |

The Rust part alone drops from 9 places to 5 (10 to 6 with `classify`). Only
one of those 5 is new code. The other four are one-line edits to central
tables, and the compiler or the parity guard points at each of them.

## Enforcement

The compiler and one test keep the verticals apart.

- **Visibility.** `nodes` is `pub(crate)` in `lib.rs`, and every module and
  item under it is `pub(crate)`. No other crate can name a node's internals.
  The desktop crate, the wasm crates, the benches and the golden tests reach
  nodes only through `runtime` and `codegen`. Because nothing in `nodes` is
  exported, the `dead_code` lint sees every node item that nothing uses. A
  config that only its runtime reads (`Pn532`, `Music`: no emitter) sits behind
  that runtime's gate.
- **Boundary guard.** `nodes/boundaries.rs` is a unit test with no feature
  gate, so a bare `cargo test -p microflow-core` runs it. It reads `src/` with
  comments and literal contents blanked. It fails when:
  1. a file in `nodes/<a>/` names another node (`crate::nodes::<b>`,
     `super::super::<b>`), or names its own node through `crate::nodes` and
     not through `super::`;
  2. a file outside `nodes/` names a node and is not a central dispatch table.
     The allowlist, `CENTRAL_DISPATCH`, holds `runtime/registry.rs`,
     `codegen/mod.rs`, `codegen/validate.rs` and `codegen/parity.rs`. An entry
     that no longer names a node also fails, so the list cannot go stale;
  3. `nodes/mod.rs` and the `nodes/<node>/` directories disagree, a file other
     than the guard sits in `nodes/` itself, or a node directory holds more
     than `mod.rs` and its declared `config.rs` / `runtime.rs` / `codegen.rs`.

  Each failure names the file, the line and the fix. Code that two nodes need
  moves to `runtime/`, `codegen/` or `config/`.

Visibility alone cannot do rule 1 or rule 2. Rust visibility follows the module
tree, so it cannot say "visible to `runtime/registry.rs` but not to
`nodes/button/`": both are outside `nodes/led/`. The test covers that gap.

## Alternatives rejected

- **Keep the horizontal trees.** This is the status quo that F7 describes. It
  keeps two category taxonomies that do not agree, and a parity review still has
  to jump between trees. Its one argument was that the feature gates need it,
  and that argument does not hold (see Context).
- **One file per node** (`nodes/<node>.rs` with inline `mod config {}` and
  `#[cfg(feature = "runtime")] mod runtime {}`). This works mechanically. But the
  largest nodes would become 900- to 1,300-line files that mix three layers
  (`I2cDevice`, `Midi`, `Function`), and the git history of each layer would end
  up in one blob. One file per layer keeps each file the size it was
  before.
- **Nest under a category** (`nodes/<category>/<node>/`). This brings back the
  taxonomy that the two trees could not agree on (`Constant`, `Interval`,
  `Monitor`) and adds a directory level. The category is a catalog grouping. It
  is not a code boundary, and no gate follows it except `cloud`, and the `cloud`
  gate is now stated on each node.
- **Auto-registration** (`inventory` / `linkme` / a `build.rs` that scans
  `nodes/`) to remove the central lines. ADR-0012 keeps plumbing explicit and
  greppable. Link-section registries are unreliable on `wasm32`, and both
  `microflow-runtime-wasm` and `microflow-codegen-wasm` build for it. The
  `build.rs` catalog codegen was already dropped once, in ADR-0006, and after
  that nothing included its output.
- **Re-export shims at the old paths.** Nothing external needs them (D4). They
  would keep the old taxonomy alive as a second name for every node.
- **A `Node` trait that bundles config, runtime and codegen.** Codegen is
  ungated and the runtime is not. A trait that spans both would either pull the
  runtime into `microflow-codegen-wasm` or need to be split in two again. The
  layers stay separate items that share one directory.

## Consequences

**Positive**

- One node is one directory. Reading it, reviewing its interpret-to-emit parity,
  or deleting it is local work. When you delete the directory, the compiler
  lists the central lines that still name it.
- The `generator`/`control` and `output`/`cloud` differences between the
  runtime and codegen trees are gone. ADR-0006's debt note is resolved.
- The feature gate of each layer can be seen next to the node, in its `mod.rs`,
  and not only in a parent directory's `mod.rs`.

**Negative**

- 35 small `nodes/<node>/mod.rs` files, each 2 to 4 lines long. Accepted: this
  file is where a node's layers and gates are listed.
- Paths are longer: `nodes::led::runtime::Led` instead of
  `runtime::output::led::Led`. Inside a vertical, the file names `runtime` and
  `codegen` look like the crate-level modules. The rule is: a node's own layers
  are reached through `super::`, and shared layers are always reached through
  `crate::`.
- The `log` / `tracing` target of node code follows its module path, so it
  changes (for example to `microflow_core::nodes::button::runtime`). The only
  filter in the repo is crate-wide (`microflow_core=debug`), so no filter
  breaks.
- The interpret-to-emit parity cases still live in `codegen/parity.rs`, next to
  `classify`, because they share its fixtures (`node`, `input`, `sketch`).
  Moving each case into its own node is possible later. This ADR does not
  require it.

**Unchanged**

- What gets compiled for each feature set, and the public API of every
  consumer (the desktop crate and the wasm crates).
- The ts-rs bindings: no per-node type is exported to TypeScript, and the
  generated `apps/web/src/lib/bindings/` files are the same byte for byte.
- `catalog_parity.rs` and `parity.rs` guard the same things they did before.

## References

- `crates/microflow-core/src/nodes/mod.rs`: the node index and the notes on
  how node emitters are written.
- `crates/microflow-core/src/runtime/registry.rs`: `register_all`.
- `crates/microflow-core/src/codegen/mod.rs`: `emit_node`, `output_expression`.
- `crates/microflow-core/src/codegen/parity.rs`: `classify`.
- `crates/microflow-core/src/nodes/boundaries.rs`: the boundary guard and
  `CENTRAL_DISPATCH`.
- [ADR-0006](0006-rehost-runtime-on-core.md): the feature split (`runtime` /
  ungated codegen + config) that the per-node gates keep.
- [ADR-0012](0012-component-trait-plumbing-stays-explicit.md): why the dispatch
  lines stay hand-written.
- `docs/plans/vertical-structure.md` § F7: the finding this resolves.
