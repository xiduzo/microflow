# The wasm error seam

The browser runs the flow engine as WebAssembly (`microflow-runtime-wasm`) and the Firmata
codec as a second module (`microflow-firmata-wasm`). Every entry point of both returns
`Result<String, JsError>`, which reaches JavaScript as a **throw**, and a Rust panic is a
wasm trap that leaves the module permanently unusable.

Two of the three callers of that surface have nowhere to put a throw: the Web Serial read
loop, whose only recovery vocabulary is "the board went away", and a `setTimeout` callback,
which has no caller at all. This seam is what keeps a Rust fault from being spoken in either
of those vocabularies.

## The bridge

`RuntimeBridge` (`apps/web/src/lib/firmata/runtime-bridge.ts:76-144`) owns the wasm flow
runtime and is the only thing that calls it. No other module holds a `FlowRuntime`.

```ts
bridge.call(op, node, (rt) => rt.feedBytes(bytes, now()));
```

- `op` — the entry point's name, for the fault record.
- `node` — the node the call is on behalf of, or `null` for a whole-flow op
  (`feedBytes`, `updateFlow`, `setPins`, `reconcileSubscriptions`, `midiListeners`).
- the callback receives the runtime; its return value (the effects JSON, or nothing for a
  void op such as `setPins`) is returned to the caller.

`call` returns `string | undefined` and **never throws**. `undefined` means the turn was
lost and the fault has already been classified and routed.

The runtime is typed as `FlowRuntimeCalls` (`runtime-bridge.ts:21-30`), a structural
interface listing the eight entry points. The generated `FlowRuntime` satisfies it, and the
module has no value import of the wasm glue — so the bridge loads, and is tested, without
instantiating wasm.

## The fault taxonomy

| class | what it is | how it is recognised | module afterwards |
| --- | --- | --- | --- |
| `badInput` | the runtime rejected this call — a Rust `Err`, i.e. `JsError` | any thrown value that is not a trap | intact |
| `engineBroken` | a wasm trap: Rust panic, stack or memory exhaustion | `WebAssembly.RuntimeError` or `RangeError` (`runtime-bridge.ts:60-65`) | poisoned |
| `disposed` | the bridge is closed and the call never reached wasm | `this.runtime === null` at call time | gone |

A fourth failure — a reply the host cannot `JSON.parse` — is not a bridge fault: the call
returned normally, so the module is not suspect. `FlowReactor.apply`
(`flow-reactor.ts:176-190`) logs it and drops the turn.

## Where each class is routed

Classification happens in the bridge; routing happens in `FlowReactor.handleFault`
(`flow-reactor.ts:202-216`), which the bridge is constructed with
(`flow-reactor.ts:120-137`):

- **`engineBroken`** → the host's `onEngineFault` callback. In the browser adapter that is
  `board-controller.ts:142-164`: the reactor is disposed, the fault is logged, and the board
  store is set to `error` alongside a toast. The condition is persistent — a trapped module
  cannot be revived, so reload is the only recovery — and a UI still reading `connected`
  would claim a flow is running when none is. No bring-up event is dispatched and the port
  is not closed.
- **`badInput` with a node** → that node's diagnostic badge, via `reportDiagnostic`
  (`flow-reactor.ts:290-292`) into `useNodeDiagnosticsStore` — the same surface the runtime's
  own `node_diagnostics` effect uses (ADR-0008), so a Rust-side fault and a node's own
  self-reported fault look identical to the user.
- **`badInput` without a node** → the console. `feedBytes` and `updateFlow` belong to no
  single node; pinning a badge on an arbitrary one would lie.
- **`disposed`** → reported once, then silent (`runtime-bridge.ts:136-144`). Wakeups and
  inbound chunks keep arriving after the bridge closes; one report per chunk would flood the
  console and the badges. A deliberate `dispose()` suppresses even the first one — teardown
  is not a fault.

Nothing in this list is a transport signal. Only `engineBroken` touches `BoardState`, and it
does so by writing the store directly — a notify without a machine transition, so the port
stays open and no reconnect is attempted.

## The poison latch

A trap sets `this.runtime = null` **before** the fault is routed
(`runtime-bridge.ts:116-127`), so:

- the handler sees a bridge that is already dead, and
- every subsequent `call` short-circuits at `runtime === null` and never re-enters wasm.

`bridge.live` (`runtime-bridge.ts:90-92`) is the observable. This is what bounds a
deterministic fault: a decode defect that traps on a particular byte sequence costs exactly
one entry into wasm, not one per chunk forever.

## What the read loop's `catch` is allowed to mean

`pumpReader` (`web-serial.ts:294-323`) drains one reader until it ends, then fires `onClosed`
exactly once. Its outer `catch` covers `reader.read()` and nothing else. That is the only
thing in the loop that can mean *the port is gone*.

Everything else is computation over a chunk that already arrived — `session.feed` (the wasm
codec) and `hooks.onBytes` (the flow runtime) — and each is contained in its own `try` so the
loop keeps reading. `onClosed` reaches `dispatch({ type: "connectionLost" })`
(`board-controller.ts:166-173`), which is how auto-reconnect starts; keeping faults out of it
is what stops a reconnect loop.

## Invariants

A change here must not break any of these:

1. **No module outside `runtime-bridge.ts` calls the wasm flow runtime.** The `FlowRuntime`
   handle is passed to the bridge constructor and never stored elsewhere.
2. **`bridge.call` never throws.** Its callers — a serial read loop, a bare `setTimeout`
   (`flow-reactor.ts:262-270`), a cloud/MIDI callback — have no catch of their own.
3. **A wasm fault never becomes a bring-up event and never closes the port.** No fault class
   may reach `dispatch({ type: "connectionLost" })` or `portGone`, and none may call
   `connection.disconnect()`. The machine's retry would close a working port and reconnect
   into the same dead module, forever. `onEngineFault` writes the board store directly for
   exactly this reason: it is a notification, not a transition.
4. **`badInput` changes no board state at all.** It is one lost turn on an intact module;
   only `engineBroken` — a permanent condition — is allowed to be board-visible.
5. **A trap poisons the bridge permanently.** No path clears the latch; recovery is a page
   reload.
6. **A closed bridge reports at most once.** Anything that adds a report per dropped call
   reintroduces the flood.
7. **`pumpReader`'s outer `catch` covers only `reader.read()`.** Any new work in the loop
   gets its own `try`.

## Verifying

`apps/web/src/lib/firmata/__tests__/runtime-bridge.test.ts` drives both halves with no wasm,
no serial port and no React: a structural `FlowRuntimeCalls` double that throws on a chosen
entry point, and a structural reader.

```sh
bun test                                   # includes the seam suite
cd apps/web && bunx tsc --noEmit
```
