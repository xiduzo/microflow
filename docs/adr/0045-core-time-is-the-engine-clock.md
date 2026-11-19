# ADR-0045 — Time in the core is the engine clock

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander
- **Extends:** [ADR-0006](0006-rehost-runtime-on-core.md)

> **Decision:** code in `crates/microflow-core` and
> `crates/microflow-runtime-wasm` reads time only from the engine clock:
> `RuntimeContext::now_ms`, which the Runtime Host sets through
> `FlowRuntime::set_now` before every call, and wakeups
> (`RuntimeContext::schedule_wakeup`). It never reads the OS clock. Each crate's
> `clippy.toml` bans `std::time::Instant` and `std::time::SystemTime`, so CI
> refuses a read of the OS clock there. The one reader of a wall clock is the
> JavaScript `Date` inside a Function node.

## Context

The core runs in two hosts. On the desktop it is native code; in the browser it
is `wasm32-unknown-unknown`, where `std::time::Instant::now()` and
`SystemTime::now()` panic ("time not implemented on this platform"). Code that
reads the OS clock compiles and passes every native test, and fails only in the
browser, at the moment it first runs.

The Trigger did exactly that. It timed its window with `Instant::now()`, so a
browser flow with a Trigger panicked on the first value that reached it, and
the runtime faulted ([ADR-0017](0017-wasm-fault-seam.md)). Every other timed
node already read the engine clock, which the re-host
([ADR-0006](0006-rehost-runtime-on-core.md)) introduced to replace the
desktop's threads and sleeps.

## Decision

**D1 — One clock.** A node reads the current time with `ctx.now_ms()`: a
monotonic number of milliseconds the host hands in. The desktop host sets it
from its own `Instant` before each call into the runtime
(`apps/web/src-tauri/src/runtime/host.rs`); the browser passes `now_ms` with
every call into the wasm runtime (`crates/microflow-runtime-wasm/src/lib.rs`);
the `SimRig` test host advances it by hand. A node that must act later asks for
a wakeup and does not wait.

**D2 — The OS clock is banned where the core is compiled.**
`crates/microflow-core/clippy.toml` and `crates/microflow-runtime-wasm/clippy.toml`
list `std::time::Instant` and `std::time::SystemTime` as disallowed types, and
their `now` as disallowed methods, each with the reason. CI runs
`cargo clippy --workspace --all-targets -- -D warnings`, so production code
and tests alike are checked. Nothing in either crate is allowed to use them. A
test that needs the OS clock opts out with
`#[allow(clippy::disallowed_types, clippy::disallowed_methods)]` and says why;
no test does today.

**D3 — The exception: a Function node's `Date`.** The Function node runs
JavaScript in boa. `Date.now()` and `new Date()` there read the wall clock
through boa's host hooks (the `time` crate, which on wasm calls the browser's
`Date`), not the engine clock. That is what a user writing JavaScript expects,
and it does not panic on wasm. It sits in a dependency, where `clippy.toml`
does not reach.

## Considered options

- **Make each node use a wasm-safe clock crate (`web-time`).** Time would work
  in both hosts but would not be the host's time: a test could not drive it,
  and a node would see a different "now" from the one its wakeups are timed
  against.
- **Review by hand.** The Trigger shows what that catches: a node that passes
  every native test.

## Consequences

- A timed node behaves the same in both hosts and in tests, which drive the
  clock deterministically.
- A node's notion of "now" is the time of the call it is in. Within one turn
  every node sees the same `now_ms`.
- The ban covers only the two crates. The desktop crate reads `Instant` to feed
  the engine clock, and that is its job.
- A Function node's `Date` is not the engine clock: a flow that mixes `Date`
  with a Delay or a Trigger compares two clocks.

## What this does NOT decide

- The resolution or origin of `now_ms`. Each host picks its own; a node uses
  only differences.
- How a host schedules the wakeups it is asked for.

## References

- `crates/microflow-core/clippy.toml`, `crates/microflow-runtime-wasm/clippy.toml` — the bans.
- `crates/microflow-core/src/runtime/context.rs` — `RuntimeContext::now_ms`, `schedule_wakeup`, `cancel_wakeup`.
- `crates/microflow-core/src/runtime/mod.rs` — `FlowRuntime::set_now`.
- `crates/microflow-core/src/nodes/trigger/runtime.rs` — the Trigger window on the engine clock ([ADR-0043](0043-timed-nodes-share-one-bound-live-and-on-the-board.md)).
- `.github/workflows/rust.yml` — the clippy job.
- `CONTEXT.md` § Runtime Host, Wakeup.
