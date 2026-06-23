# ADR-0007 — Bidirectional node wire-interface contract: typed Emits + live catalog-parity guard

- **Status:** accepted
- **Date:** 2026-06-21
- **Deciders:** sander

## Context

A flow node's edge interface has **two** directions: the **Port** set (edge
inputs, `target_handle`) and the emit set (edge outputs, `source_handle`). The
**Component Catalog** (`apps/web/node-components.json`) is documented as the
single source of truth for a node — but it represents only the input half, and
even that half's cross-language guard is dead:

- **Input `ports`** flow catalog `impls[].ports[]` → Rust `Component::ports()`
  (`crates/microflow-core/src/runtime/component.rs:33`) → TS `COMPONENT_PORTS` /
  `PortOf<T>` (`codegen-node-registry.ts:23-76` → `_base/_base.types.ts`). The
  Rust↔catalog drift assertion that `build.rs` used to generate into
  `register_all_body.rs` is **dead**: after the re-host (ADR-0006) the registry
  hand-registers nodes (`registry.rs:73-121`) and **nothing `include!`s the
  generated file**. `build.rs` still writes it; no code reads it. The guard
  silently stopped running.

- **Output emits have no representation anywhere.** A component emits via
  `ComponentBase::emit(handle: &str)` (`component.rs:181`), which pushes a
  `ComponentEvent { source_handle: Arc<str>, .. }` (`value.rs:100`). The handle
  is a free string literal (`self.base.emit("event")`). The React node renders
  `<Handle type="source" id="event">` with another free literal
  (`handle.tsx`, `BaseHandle<T>` does not constrain `id`). There is **no catalog
  field, no codegen, no type, and no test** linking the two. A mismatch —
  `emit("value")` vs `id="valued"`, or the documented MQTT `"message"`→`"value"`
  rename — makes the edge route nowhere. The event is dropped silently (a warn at
  most). This is a live correctness hole, not a hypothetical.

Tally of the four cross-language agreements a node depends on: **one is live
(TS `COMPONENT_PORTS` codegen), zero are tested.**

An audit of every component's emit set (recorded below in Decision D1) also
surfaced a subtlety: `ComponentBase::set_value()` **auto-emits `"value"`** when
the value changes. So `"value"` is an *implicit* emit for the 23 components that
mutate value through `set_value`, distinct from the explicit `emit("…")` calls
(e.g. Button's `event`/`true`/`false`/`hold`). Four components (`Delay`, `Mqtt`,
`Llm`, `Figma`) deliberately bypass `set_value` with a raw `base.value =` write
and emit their handles explicitly.

The core crate today contains **zero `macro_rules!`**; the house style is flat
and explicit (`ports()` is a hand-written `&["true","false",…]` literal;
`register_all` is a hand-written list). Any mechanism this ADR adds must respect
that ethos.

## Decision

Make the catalog the node's **whole** wire interface, extend the input-side
discipline (ADR-0001) to the output side, and re-arm the dead guard as a *live*
test.

- **D1 — Catalog gains `impls[].emits[]`**, symmetric with `ports[]`. The emit
  set is the closed `source_handle` namespace a node may emit on a flow edge.
  `"value"` is listed for every node that emits it (implicitly via `set_value`
  or explicitly). Internal/wakeup names (`_hold`, `_tick`, `_debounce`) are
  **not** emits — they are self-routed internal events (ADR-0001) and never
  appear on an edge, so they are excluded. The authoritative initial sets (from
  the audit) are e.g. `Button: [event,true,false,hold,value]`,
  `Compare/Gate: [true,false,value]`, `Delay: [event]`, `Trigger: [bang,value]`,
  `RangeMap: [to,value]`, `Llm: [thinking,value,done,error]`,
  `Figma: [change,value]`, and `[value]` for the value-only sinks/sources.

- **D2 — Rust emits are compile-checked via associated const handles, not raw
  literals.** A `Component::emits()` associated function is added (parallel to
  `ports()`, default `&[]`). Each component declares its emit handles as
  associated `const`s and references them at every emit site **and** in
  `emits()`:

  ```rust
  impl Button {
      const E_EVENT: &'static str = "event";
      const E_TRUE:  &'static str = "true";
      const E_FALSE: &'static str = "false";
      const E_HOLD:  &'static str = "hold";
  }
  impl Component for Button {
      fn emits() -> &'static [&'static str] {
          &[Self::E_EVENT, Self::E_TRUE, Self::E_FALSE, Self::E_HOLD,
            ComponentBase::VALUE_HANDLE]
      }
      // …
  }
  // emit site:
  self.base.emit(Self::E_TRUE);   // a typo'd `Self::E_TREU` does not compile
  ```

  The implicit `"value"` emit is centralized on the base:
  `ComponentBase::VALUE_HANDLE: &'static str = "value"`, used by `set_value` and
  listed in `emits()` by any value-emitting node. A declarative macro was
  rejected — it would be the crate's first `macro_rules!` and break the flat,
  explicit house style; associated consts are how the team already writes
  `type Config` and `ports()`. (A per-component emit enum was also considered and
  rejected for the same churn-without-house-fit reason; consts give the
  "mistyped emit won't compile" guarantee the team asked for.)

- **D3 — Codegen emits `COMPONENT_EMITS` + `EmitOf<T>`**, an exact parallel of
  `COMPONENT_PORTS`/`PortOf<T>` in `codegen-node-registry.ts`. The shared
  `Handle` component is then constrained so `id` on `type="source"` must be
  `EmitOf<T>` and on `type="target"` must be `PortOf<T>`. React source handles
  become type-checked against the same catalog row.

- **D4 — One live parity test replaces the dead `build.rs` guard.** A build
  script cannot introspect Rust trait impls (the old design *generated*
  `assert_eq!` into compiled Rust). The modern guard is a Rust integration test
  that loads `node-components.json` and asserts, for every impl,
  `ports() ≡ catalog.ports` **and** `emits() ≡ catalog.emits`. It lives in the
  **desktop** crate (`apps/web/src-tauri/tests/catalog_parity.rs`): desktop
  already depends on `microflow-core` and can resolve the catalog path, so core
  stays free of the `apps/web` layout. It hand-lists the same type→name mapping
  as `register_all` (acceptable duplication; macro-shareable later). The existing
  exhaustive-match idiom in `crates/microflow-core/src/codegen/parity.rs` is
  extended so a new port/emit cannot be added without a conscious classification.
  (Embedding the catalog into core via a cross-crate `include_str!` was rejected
  — it couples core to the `apps/web` directory layout.)

### Rollout (each phase compiles and ships)

1. **Catalog + Rust declaration.** Add `emits[]` to every `impls[]` row. Add
   `Component::emits()` (default `&[]`) and `ComponentBase::VALUE_HANDLE`;
   migrate all ~30 components to const-based emits + an `emits()` body. Behaviour
   unchanged.
2. **Guard.** Add `catalog_parity.rs` (ports + emits, both directions). Expect it
   to surface pre-existing drift — fix what it finds (see Consequences).
3. **TS types.** Extend codegen with `COMPONENT_EMITS` + `EmitOf<T>`; constrain
   `Handle`. Run `bun run codegen`; fix the type errors the constraint surfaces
   in node `.tsx` files — those are latent bugs.

## Consequences

**Positive**

- The silent emit-drop bug class is closed at CI and at the type level, not on a
  user's canvas. Renaming a handle is one edit the guard propagates or rejects.
- "What does this node emit?" is answered by `<Impl>::emits()` and the catalog
  `emits[]` — one declaration, mirrored to TS, asserted equal.
- Compile-checked emit sites: a mistyped `Self::E_*` does not compile.
- The dead ADR-0006 port-drift debt is repaid as a *better* guard — a live
  CI test covering both directions, not dead build-script output. The dead
  `build.rs` codegen for ports can now be deleted.
- Deletion test passes: delete `catalog_parity.rs` + `COMPONENT_EMITS` and the
  cross-language drift hole reappears across catalog, ~30 Rust impls, and every
  node `.tsx`.

**Negative**

- Phase 2 will likely surface existing drift (a component emitting a handle the
  `.tsx`/catalog never declared a source `Handle` for; or a stale handle id).
  Budget fix time — this is the guard doing its job, e.g. verifying every
  `set_value`-driven `"value"` emit on an output node actually has a UI sink.
- Touches all ~30 component files (the const migration) plus 36 catalog rows.
  Mechanical, one file each; mitigated by the phased rollout.
- `catalog_parity.rs` duplicates the `register_all` type list. Accepted; a shared
  macro can fold it later if it drifts.

**Neutral**

- `ports()`-as-literal stays as-is on the input side; this ADR adds the symmetric
  `emits()` and the guard that finally checks both. The frontend `PortOf<T>`
  already existed; `EmitOf<T>` completes the pair.

## Glossary

New / updated terms recorded in `CONTEXT.md`:

- **Emit** — a named edge-output slot (`source_handle`) a Component may emit on.
  The closed set declared by `Component::emits()`, mirrored to catalog
  `impls[].emits[]` and TS `COMPONENT_EMITS`/`EmitOf<T>`. Symmetric with **Port**.
  Excludes `_`-prefixed **Internal Event** names.
- **Catalog Parity Guard** — the live `catalog_parity.rs` test asserting Rust
  `ports()`/`emits()` ≡ catalog, replacing the dead `build.rs` assertion.
- **Port** (updated) — note the build-time drift assertion is dead; the guard now
  lives in `catalog_parity.rs`.

## References

- `apps/web/node-components.json` — `impls[].ports[]`; gains `emits[]`.
- `crates/microflow-core/src/runtime/component.rs` — `Component::ports()`;
  `ComponentBase::emit`/`set_value`; gains `emits()` + `VALUE_HANDLE`.
- `crates/microflow-core/src/runtime/value.rs:100` — `ComponentEvent.source_handle`.
- `crates/microflow-core/src/runtime/registry.rs` — hand-registration; no `include!`.
- `apps/web/src-tauri/build.rs` — dead port codegen (to delete after Phase 2).
- `crates/microflow-core/src/codegen/parity.rs` — exhaustive-match guard idiom.
- `apps/web/scripts/codegen-node-registry.ts` — `COMPONENT_PORTS`/`PortOf<T>`;
  gains `COMPONENT_EMITS`/`EmitOf<T>`.
- `apps/web/src/components/flow/nodes/../../handle.tsx` — `BaseHandle<T>` to constrain.
- `apps/web/src-tauri/tests/catalog_parity.rs` — new live guard.
- [ADR-0001](0001-component-trait-flow-separation.md) — Port/Internal/Hardware split
  this extends to the emit side.
- [ADR-0006](0006-rehost-runtime-on-core.md) — names the dead port-drift guard as debt.
