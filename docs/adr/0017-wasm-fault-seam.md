# ADR-0017 — One seam owns the wasm crossing; a runtime fault is never transport news

- **Status:** implemented (2026-08-26); amended (2026-11-13)
- **Date:** 2026-08-26
- **Deciders:** sander

> **Decision:** every browser call into the wasm `FlowRuntime` goes through
> `RuntimeBridge` (`apps/web/src/runtime/runtime-bridge.ts`). It catches,
> classifies (`badInput` / `engineBroken` / `disposed`), latches closed on a
> module trap, and returns `undefined` instead of throwing. A wasm fault reaches
> a **runtime** surface — the node diagnostic badge or the board error state —
> and never the **transport**: the bring-up machine's `connectionLost` is
> reachable only from a failed transport — `reader.read()` ending, or a write
> the port rejected.

## Context

The browser **Runtime Host** ([ADR-0006](0006-rehost-runtime-on-core.md)) drives
the engine over a wasm boundary whose every entry point is
`Result<String, JsError>` on the Rust side — a **throw** on the JS side. Two
properties of that boundary shape everything below:

1. A `JsError` is a value the Rust code chose to return. The module is intact;
   the call was rejected. This is ordinary input validation crossing a language
   boundary.
2. A Rust **panic** is not. It traps the wasm instance: `console_error_panic_hook`
   logs it, and from then on *every* call into that module throws. The module is
   a corpse and cannot be revived without a fresh instance.

Neither is news about the board. The USB device is plugged in, the port is open,
and bytes keep arriving. But the host's call sites sit inside structures that
interpret an exception as something else entirely:

- `feedBytes` is called from the Web Serial read loop. An exception escaping it
  ends the loop, which fires `onClosed()` → `connectionLost` → the bring-up
  machine closes the port and schedules a retry. A **deterministic** decode fault
  therefore reconnects, re-feeds, throws, and disconnects — forever, presenting
  as flaky hardware, with the error object discarded.
- `wake` is called from a bare `setTimeout`. A timer callback has no caller to
  catch anything: the throw escapes to the top, the flow stops, and no surface in
  the app says so.

Both are the same defect: a fault at the wasm crossing is interpreted by whatever
happened to be on the stack. There were nine such call sites, each with its own
(mostly absent) recovery, so there was no single answer to "what happens when
Rust fails".

## Decision

**D1 — One crossing.** `RuntimeBridge` owns the runtime handle. No call site
holds a `FlowRuntime`; `FlowReactor` holds a bridge and every op goes through
`bridge.call(op, node, fn)`. The bridge never throws — callers get the reply or
`undefined`. This is what makes the guarantees below statements about the *host*
rather than about nine call sites.

**D2 — Three fault classes, three responses.** The taxonomy is exhaustive over
what can go wrong at the crossing:

| Class | Cause | Response | Surface |
|---|---|---|---|
| `badInput` | Rust returned `Err` | drop this turn, keep going | node badge if the op names a node, else console |
| `engineBroken` | wasm trap (panic, stack exhaustion) | latch closed, write the safe state, close the port | board error state |
| `disposed` | bridge already closed | drop silently | console, once |

The routing (`FlowReactor.handleFault`) is per class, not per call site:

- **`engineBroken` → the board error state**, via an `onEngineFault` callback the
  board controller supplies. The engine is gone, so this is not one node's
  problem — no per-node badge could be true, and the flow as a whole has stopped.
  It is the only class the user must act on (reload), so it gets the loudest
  surface the host already has.
- **`badInput` with a node → that node's diagnostic badge**
  (`useNodeDiagnosticsStore`), the same channel the runtime's own
  `node_diagnostics` effect uses ([ADR-0008](0008-effects-apply-policy.md)). Only
  `wake`, `injectEvent` and `deliverMessage` carry a node id; those are exactly
  the ops where one node is genuinely at fault.
- **`badInput` without a node → the console.** `feedBytes`, `updateFlow`,
  `setPins`, `reconcileSubscriptions` and `midiListeners` belong to the runtime
  as a whole. Pinning a badge on an arbitrary node would be a lie, and the board
  is still working, so the board error state would be one too.

**D3 — A trapped module is terminal, by policy.** A wasm trap does not destroy
the instance: the trap unwinds the JS call, and the module remains mechanically
callable afterwards (true under both `panic = "abort"` and `panic = "unwind"` —
on `wasm32-unknown-unknown` the key does not change what the target does). What
the panic destroys is the runtime's *invariants*: it aborted mid-mutation and no
destructor ran, so the engine's internal state is indeterminate and any flow it
drives afterwards is undefined.

So "poisoned" is a host-side judgement, not something wasm reports. `engineBroken`
latches the bridge closed *before* the fault is routed, so the handler already
sees a dead bridge and nothing can call back into a runtime whose state is gone.
A per-chunk or per-tick loop over a trapped module faults once, not thousands of
times. The host's answer is **surface it, make the board safe, and stop** —
never retry, because a retry would drive an engine whose state cannot be
trusted. The board controller feeds the bring-up machine `disconnectRequested`,
its teardown with no retry: the link writes the [safe state](../../CONTEXT.md#safe-state)
over the still-working port and closes it, so no output stays driven by the dead
flow's last writes. It must not be `connectionLost`: the transport did not fail,
and the machine's retry would reconnect into the same dead module. The error
latches until the page reloads; every bring-up path refuses while it stands.

**D4 — `onClosed` means the reader ended, and nothing else.** The read loop is
`pumpReader` (`board-link.ts`). The only statement inside it that can mean *the
port is gone* is `await reader.read()`; everything else is computation over a
chunk that already arrived — the detection codec (`session.feed`, also wasm) and
`onBytes` (which crosses into the flow runtime). Those are contained per chunk so
the loop keeps reading. `onClosed` fires when the reader ends. The board link
reports a lost transport — the reader ended, or a write was rejected — once,
through `onLost`, and that is the only path to the bring-up machine's
`connectionLost` and its auto-reconnect.

D1 and D4 are independent: the bridge means nothing throws at `onBytes`, and the
pump means it would not matter if something did. Auto-reconnect keeps working
because the genuine path — `reader.read()` rejecting or returning `done` — is
untouched.

## What this does NOT cover

- **The `Effects` apply order.** Fixed by [ADR-0008](0008-effects-apply-policy.md).
  The bridge sits *before* `applyEffects`; a faulted turn produces no effects at
  all, so nothing is applied out of order or half-applied.
- **Recovery from a trapped module, in the browser.** There is none.
  Re-instantiating the wasm module behind a live board is a larger change (pin
  table re-seed, flow re-apply, subscription re-reconcile); the user reloads. The
  desktop host does recover; see the amendment below.
- **The other two wasm modules.** `FirmataSession` (detection codec) and
  `BringUpMachine` (bring-up policy) are separate instances with their own
  boundaries. `session.feed` is contained by D4; `session.pinsJson`,
  `FlashSession`, and `machine.handle` are not behind this seam. They run inside
  probe/flash paths whose failure already means "this probe failed", which the
  bring-up machine handles.
- **Decode faults.** `feedBytes` is the highest-traffic crossing and names no
  node, so a recurring decode defect is console-only. The runtime attributes
  build, start and rejected-input faults to their node itself (see the
  amendment below); a decode fault has no node to attribute it to.

## Consequences

**Positive**

- One answer to "what happens when Rust fails", stated once and testable without
  wasm: `RuntimeBridge` takes a structural `FlowRuntimeCalls`, so a fault is
  exercised with a plain object.
- The reconnect loop and the silent death are both closed by construction rather
  than by a guard at each call site.
- `onClosed` regained a meaning narrow enough to trust.

**Negative**

- Call sites read as `bridge.call("op", node, (rt) => rt.op(...))` instead of
  `runtime.op(...)` — one indirection, and the op name is a string the bridge
  cannot check. Accepted: the string only ever appears in a fault report, and the
  structural `FlowRuntimeCalls` still type-checks the call itself.
- A `badInput` fault on a nodeless op is console-only, so a persistent one is
  quiet. Accepted over a false attribution; see *does NOT cover*.

**Neutral**

- The trap heuristic (`WebAssembly.RuntimeError`, `RangeError`) classifies
  conservatively: an unrecognised throw is `badInput`, so the worst case is a
  repeating fault rather than a wrongly-terminal engine.

## Glossary

New terms recorded in `CONTEXT.md`:

- **Runtime Bridge** — the single owner of the browser's wasm `FlowRuntime`
  handle. Converts a throw at the crossing into a classified `RuntimeFault`, and
  latches closed on a module trap.
- **Poisoned runtime** — a wasm instance that has trapped. Every later call into
  it throws; the bridge stops calling it and the host surfaces the stop.

## References

- `apps/web/src/runtime/runtime-bridge.ts` — the seam.
- `apps/web/src/runtime/flow-reactor.ts` — `turn` / `handleFault`: every crossing and the routing.
- `apps/web/src/board/board-link.ts` — `pumpReader`: `onClosed` means the reader ended; `onLost`: a failed transport, reported once.
- `apps/web/src/board/board-controller-core.ts` — `onEngineFault`: the board error state, then `disconnectRequested`.
- `apps/web/src-tauri/src/runtime/supervisor.rs` — the desktop Runtime Supervisor (amendment below).
- `crates/microflow-core/src/runtime/turn_budget.rs`, `runtime/health.rs` — the turn budget and the node health ledger (amendment below).
- `apps/web/src/runtime/runtime-bridge.test.ts` — containment, poisoning, and that a throwing runtime does not close the board.
- [ADR-0006](0006-rehost-runtime-on-core.md) — the sans-IO runtime this hosts.
- [ADR-0008](0008-effects-apply-policy.md) — the apply policy that runs after a successful crossing.

---

**Amendment (2026-08-31):** the first negative consequence is resolved.
`RuntimeBridge` now exposes one typed entry point per runtime op
(`updateFlow`, `wake`, `feedBytes`, `dispatch`, `injectEvent`,
`deliverMessage`, `reconcileSubscriptions`, `midiListeners`, `setPins`),
each owning the op name, the JSON encode of its arguments and the decode of
its reply into the ts-rs binding types; `call()` is the private core behind
them, so call sites read as `bridge.updateFlow(flow, now)` rather than
`bridge.call("op", node, fn)`. A reply the host cannot decode classifies as
`badInput`. The seam and the fault taxonomy are unchanged.

---

## Amendment (2026-11-13): a runaway flow is a node fault, and the desktop recovers

**Turn budget.** Core stops any turn after `TURN_BUDGET` (10 000) drained events
and drops the rest of that turn's queue, so a flow that never settles — two
Gates wired into each other — cannot hang the tab or the desktop actor, nor
every collaborator who opens the persisted flow. The runtime stays alive. If the
turn's last emitters sit on a cycle, every node of that cycle's strongly
connected component is **paused**: it still runs, but its emits are not routed,
until a flow update reshapes the loop. Without a cycle (an acyclic fan-out),
nothing is paused and the node where the budget ran out gets a warning. A
runaway loop is therefore never `engineBroken`; it is a badge on the nodes that
cause it.

**Node health attribution.** The runtime keeps its own ledger of what is wrong
with each node (`NodeHealth`, `runtime/health.rs`): a node that could not be
built, an `initialize`/`on_start` that failed (a missing firmware feature among
them), a paused node, a pin the board cannot serve (`runtime/pin_check.rs`), an
overloaded turn, an output held during a reset storm, a rejected input. It
raises and clears on a change only and reports through the existing
`Effects.node_diagnostics` channel. Each diagnostic carries an **origin** —
`runtime` for the ledger, `node` for what a node says about itself — and an
origin clears only its own, so the ledger never wipes a node's I2C NACK. The
badge shows the more severe of the two. This closes the gap for every runtime
fault except a `feedBytes` decode fault (see *does NOT cover*).

**`connectionLost` on a rejected write.** D4's rule now covers the outbound
direction. The browser board link turns `lost` when `writer.write` rejects, as
it does when the reader ends, and reports it once through `onLost`; that becomes
`connectionLost`. A wasm fault still never does.

**`engineBroken` makes the board safe.** See D3: the controller feeds
`disconnectRequested`, the link writes the safe state (every digital port 0,
`SYSTEM_RESET`, every port 0 again; `microflow_core::firmata::encode_safe_state`)
and closes the port. Both hosts use that one encoder whenever they let go of a
working board.

**The desktop respawns; the browser stays reload-only.** The desktop actor is an
app-lifetime thread that owns the board's port, and the desktop release build
unwinds on panic, so it can recover where the browser cannot. Every actor turn
runs under `catch_unwind` (`apps/web/src-tauri/src/runtime/supervisor.rs` for
the policy, `Actor::recover` in `host.rs` for the actor half). A panic:

1. emits `runtime-crashed` with a non-PII fingerprint — the turn's op and the
   panic's crate-relative code location, never the message — which the webview
   toasts and passes to `reportError`;
2. discards the runtime, applying D3's judgement: its invariants died with the
   turn, so it never drives the board again, and neither do its timers;
3. writes the safe state through the live board session;
4. **respawns**: a fresh runtime seeded from the session's pin table, the last
   flow re-applied, then the subscriptions reconciled against the respawned
   runtime's wirings — MQTT/Figma through `reconcile_subscriptions` (a diff, so
   an unchanged set touches nothing), MIDI listeners on the actor. It does not
   restore outputs: a panicked runtime's last values are not trusted.

A `CrashGuard` halts the actor instead after 3 panics within 60 s, including a
respawn that itself panics, so a deterministic fault does not loop. The board is
then left in the safe state until the user restarts (`runtime_restart`, behind
the error's Reload action). While halted, the actor drops every turn that would
drive the flow and answers a `flow_update` with an error (`HALTED`); it keeps
that flow for the restart. The `runtime_status` command reports the halt and
the crash that caused it. The webview asks for it on start, so a reloaded
webview shows the halt again; a reload alone never restarts the runtime. The
desktop release profile must never use `panic = "abort"`, or none of this can
catch anything.

The browser keeps D3 unchanged. A trapped wasm module would need a fresh
instance behind the live board, and the reload that provides one is cheap there.
