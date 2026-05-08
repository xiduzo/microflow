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

In `apps/web/src-tauri/src/runtime/base.rs`. The interface every impl satisfies. Audited and being split (see `docs/RUNTIME_AUDIT_APRIL_2026.md` §3.5 / §3.3).

## Wiring

Per-impl description of how a constructed **Component** attaches to its execution environment. Returned as plain data from the trait (or sibling `ExternalSubscriber` trait); the runtime reads and applies it without naming any specific component.

Replaces the instance-name `match` blocks formerly in `runtime/mod.rs::register_component_pin_listener` and `runtime/commands.rs::extract_*`. Wiring is **descriptive, not active** — components return data, runtime acts. Lets a component's wiring be tested as a value, no `&mut self`, no sinks.

Two kinds:

- **Listener Wiring** — sync, in-process. Pin (digital, or analog with threshold), I2C address, hotkey accelerator. Returned from `Component::listener_wiring()` as `Vec<ListenerWiring>`.
- **Subscriber Wiring** — async, broker-dependent. MQTT topic + handler kind. Returned from `ExternalSubscriber::subscriber_wiring()` (only impl'd by components that need brokers, e.g. `Mqtt`, `Figma`).

Distinct from the **Component Catalog**: catalog is metadata for _registration_ (what UI shows, how to construct); Wiring is per-impl _behavior_ applied after construction.

## Runtime Context

Read-only bundle passed to component factories at construction time: connected brokers, configured LLM providers. Lets a component pluck the bits it needs (e.g. `Llm` reads its provider's `base_url`/`api_key`) without mutating `node.data` upstream. Empty for components with no external deps.

## Host Adapter

Frontend mirror of **Wiring**. Each node component module may export an `adapter: NodeHostAdapter` (see `apps/web/src/components/flow/nodes/_base/host-adapter.ts`) describing what the host store + global hotkey listener need from this node:

- `prepareData(node, hosts)` — partial `data` patch to merge before sync (e.g. `Figma` injects `uniqueId` from `useFigmaStore`).
- `brokerIds(node)` — broker IDs this node depends on; collected and forwarded to the runtime.
- `accelerator(node)` — keyboard accelerator this node listens to; registered with `useHotkeys`.

The catalog `impls[].usesHostAdapter` flag drives codegen: when `true`, `_REGISTRY.ts` imports the entry's `adapter` export. The frontend registry exposes `adapter` on every entry (undefined when no adapter is needed), so consumers walk it without pattern-matching `data.instance`.
