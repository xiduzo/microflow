# ADR-0006 — Re-host the Live Flow Runtime on microflow-core via a sans-IO `Effects` seam

- **Status:** accepted
- **Date:** 2026-06-19
- **Deciders:** sander

## Context

ADR-0001 and ADR-0002 describe a `Component` trait, a `FlowRouter`, and a board
layer that all lived in the desktop crate at `apps/web/src-tauri/src/runtime/`.
That engine assumed a host: it drove the serial port through an `Arc<BoardHandle>`
+ `BoardCommand` channel + a single-threaded **Board IO Loop**, scheduled timers
with `std::thread::sleep`, and read the clock directly.

Phase-1 browser execution (run a Flow live over Web Serial, no Tauri) needed the
same engine in a `wasm32` build. Two bad options presented themselves: port the
engine a second time (duplicate ~30 component impls + the executor + the router,
guaranteeing drift), or compile the desktop crate to wasm (impossible — it pulls
`serialport`, `tokio`, the Tauri runtime).

The engine also can't *be* IO-bound in wasm: there is no blocking serial read, no
`std::thread`, no monotonic `Instant` on that target. Any shared engine has to
stop owning IO.

## Decision

Extract the engine into the platform-independent **`microflow-core`** crate and
make it **sans-IO**; let each platform host it. The desktop's duplicate runtime
is deleted (commit `2f5a4ce`); the desktop now hosts the same `core::FlowRuntime`
the browser does.

- **D1 — Engine in `microflow-core`, gated behind the `runtime` feature.**
  `crates/microflow-core/src/runtime/` owns the `Component` trait, `FlowRouter`,
  `ComponentRegistry`, the board writer, and every phase-1 node impl. Codegen
  (`src/codegen/`) and the Flow read-model (`src/flow/`) stay **ungated** so
  codegen-only consumers compile without the runtime's deps (`rustc-hash`,
  `thiserror`). Three wasm crates result: `microflow-firmata-wasm` (codec),
  `microflow-runtime-wasm` (engine, opts into `runtime`+`js`), and
  `microflow-codegen-wasm` (sketch generation, no features — stays lean).

- **D2 — Sans-IO: a node never touches IO; it is handed a `RuntimeContext`.**
  During one `dispatch` / `on_pin_change` / `wake`, a node gets a
  [`RuntimeContext`](../../crates/microflow-core/src/runtime/context.rs) exposing
  a board writer (encodes into a buffer), the host clock (`now_ms`), and a wakeup
  scheduler (records requests). It cannot block, sleep, or read a wire.

- **D3 — Each turn folds into one `Effects` the host executes.** When the turn
  drains, the runtime returns
  `Effects { outbound_bytes, component_events, wakeups, cancellations }`. The host
  writes the bytes to the port, dispatches the events to its UI stores, arms the
  wakeups as timers, and clears the cancellations. Every public entry point
  (`update_flow`, `feed_bytes`, `wake`, `dispatch`, `deliver_message`,
  `inject_event`, `dispatch_key_event`) returns `Effects`.

- **D4 — `BoardWriter` replaces the `BoardHandle` / `BoardCommand` /
  `CommandReceipt` / **Board IO Loop** stack.** Hardware nodes call a typed
  [`BoardWriter`](../../crates/microflow-core/src/runtime/board.rs) whose
  `BufferBoardWriter` adapter encodes Firmata bytes straight into the turn's
  outbound buffer via the shared `FirmataClient` codec — one-to-one with the old
  `BoardConnection` encode bodies, minus all I/O. The oneshot-receipt channel, the
  IO loop, and `TestIoLoop` are gone; a test now drives `dispatch` and inspects
  `Effects.outbound_bytes`.

- **D5 — Timers become scheduled wakeups.** A timer node calls
  `ctx.schedule_wakeup(method, delay_ms)` / `cancel_wakeup(method)`; these surface
  as `Effects.wakeups` (a `Wakeup { id, node_id, method, delay_ms }`) and
  `Effects.cancellations`. The host owns the actual timer and calls
  `FlowRuntime::wake(node_id, method)` when it fires. Replaces `thread::sleep`.

- **D6 — Two host adapters at the `Effects` seam.** The seam is real because two
  concrete adapters satisfy it:
  - **Desktop** (`apps/web/src-tauri/src/runtime/host.rs`): a `!Send`
    `FlowRuntime` lives inside a dedicated actor thread (`run_actor`) that owns the
    serial port and a Tokio handle for timers and cloud I/O. Only `Send` handles
    cross the spawn boundary; cloud-node results re-enter via `inject_event`
    through a `ChannelEmitter`.
  - **Browser** (`apps/web/src/lib/firmata/flow-reactor.ts`): a `setTimeout`/Web
    Serial loop that applies the same `Effects` — bytes to the port, events to the
    Zustand stores, wakeups to `setTimeout`, cancellations to `clearTimeout`.

## Consequences

**Positive**

- One engine, two hosts. The ~30 node impls, the router, and the executor exist
  once. No interpret-side duplication across desktop and browser.
- The runtime is testable without hardware *or* a host: feed a `FlowUpdate`,
  assert on the returned `Effects`. No `MockBoardHandle`, no IO loop to stand up.
- The wasm engine build stays lean — codegen and the read-model don't drag in the
  runtime's deps.

**Negative / debt this creates**

- **The desktop `build.rs` catalog codegen is now dead.**
  `apps/web/src-tauri/build.rs` still parses `node-components.json` and writes
  `register_all_body.rs` (carrying a `ports()`-vs-catalog **port-drift
  assertion**), but core hand-registers nodes in `ComponentRegistry::register_all`
  and **nothing includes that generated file**. The Rust↔catalog port-drift guard
  silently stopped running in the re-host. Restoring an equivalent guard (Rust
  `ports()` ≡ catalog `impls[].ports`) is follow-up work, tracked alongside the
  emit/handle-seam deepening.
- The runtime and codegen category trees diverged (`Constant`/`Interval` sit under
  `generator/` in the runtime but `control/` in codegen). Harmless, but a shared
  per-node module must not assume one taxonomy — see ADR's sibling work on a flat
  `config` module.
- `tone()` pitch fidelity is intentionally coarse on the sans-IO path (no
  sub-millisecond pin toggling without a host spin-loop). Documented at the call
  site.

**Supersedes (paths only)**

- The file references in **ADR-0001** and **ADR-0002** (both) point at
  `apps/web/src-tauri/src/runtime/…`. The *decisions* (Port/Internal/Hardware
  separation; the FlowRouter seam; per-capability service traits) still hold; the
  code lives under `crates/microflow-core/src/runtime/…` now. Each carries a
  relocation banner pointing here.

## Glossary

New terms recorded in `CONTEXT.md`:

- **Sans-IO Runtime / RuntimeContext** — the per-turn capability context.
- **Effects** — the side-effect record a host applies after each turn.
- **BoardWriter / BufferBoardWriter** — the sans-IO Firmata write surface.
- **Wakeup** — a host-armed timer callback replacing `thread::sleep`.
- **Runtime Host** — the desktop actor / browser reactor that applies `Effects`.

## References

- `crates/microflow-core/src/runtime/context.rs` — `RuntimeContext`, `Effects`, `Wakeup`.
- `crates/microflow-core/src/runtime/board.rs` — `BoardWriter`, `BufferBoardWriter`.
- `crates/microflow-core/src/runtime/mod.rs` — `FlowRuntime` entry points + `_`-prefix routing.
- `crates/microflow-core/src/runtime/registry.rs` — hand-registration; build.rs codegen dropped.
- `apps/web/src-tauri/src/runtime/host.rs` — desktop actor-thread adapter.
- `apps/web/src/lib/firmata/flow-reactor.ts` — browser reactor adapter.
- Commit `2f5a4ce` — "refactor(desktop): delete the duplicate runtime, re-host on microflow-core".
- ADR-0001, ADR-0002 (router + per-capability) — superseded paths.
