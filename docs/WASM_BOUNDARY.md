# The React ↔ Rust (WASM) boundary

How the browser host talks to the Rust engine compiled to WebAssembly. For binary
sizes, build settings and crossing-cost measurements, see
[WASM_BOUNDARY_AUDIT.md](audits/WASM_BOUNDARY_AUDIT.md).

## The three modules

The browser loads three independent wasm modules. Each is a thin `wasm-bindgen`
shim over `microflow-core` and adds no logic of its own — the desktop app runs the
same core natively, so neither host is the source of truth for behaviour.

| Module | Surface | Host code |
|---|---|---|
| `microflow-runtime-wasm` | `FlowRuntime` — the flow engine | `runtime/runtime-bridge.ts`, held by `runtime/flow-reactor.ts` |
| `microflow-firmata-wasm` | `FirmataSession` (codec), `BringUpMachine`, `FlashSession` | `board/board-link.ts`, `board/board-controller-core.ts`, `board/web-serial.ts` |
| `microflow-codegen-wasm` | Arduino sketch generation | `sketch/codegen/` |

Each has its own memoised `ensureReady()` and is fetched through Vite's `?url`, so
no `.wasm` is on the critical path to first render. Every exported helper awaits
readiness before touching the module.

## What crosses

Entry points take and return JSON strings; the host `JSON.parse`s the reply. The
runtime folds each turn into one `Effects` value the host applies in the canonical
order fixed by [ADR-0008](adr/0008-effects-apply-policy.md). A turn that produced
nothing returns the empty string, which the host reads as "no effects" without
parsing.

The flow runtime's ops fall into three groups:

| Group | Ops | Returns |
|---|---|---|
| Turns on behalf of one node | `wake`, `dispatch`, `injectEvent`, `deliverMessage` | `Effects` |
| Whole-flow turns | `updateFlow`, `feedBytes`, `keyEvent`, `midiMessage` | `Effects` |
| Questions | `reconcileSubscriptions`; `listensToMidi`, `wantsMidiInput`, `midiDeviceMatches` | `DesiredSub[]`; a boolean |

Every turn takes the host's time (`now_ms`), which becomes the engine clock that
nodes read (`ctx.now_ms()`). Core never reads the OS clock: on
`wasm32-unknown-unknown` that panics. `clippy.toml` in `microflow-core` and
`microflow-runtime-wasm` bans `std::time::Instant` and `std::time::SystemTime`.

`setPins` seeds the pin table and returns nothing. `keyEvent` and `midiMessage`
are **host input**: a key or a MIDI message goes in with no node id, and core
picks the nodes that hear it ([ADR-0037](adr/0037-core-owns-host-input-fan-out.md)).
The three MIDI questions are how the host learns which ports to open; no listener
list crosses.

The flash drivers cross the same way in the firmata module: `FlashSession.start()`
and `advance(bytes)` each return one JSON `FlashStep`, which the Web Serial
executor (`runFlash` in `board/web-serial.ts`) carries out
([ADR-0038](adr/0038-bootloader-protocols-once-in-core.md)). It keeps the same
step contract as the desktop executor: a `transact` step discards buffered
input unless it says `keepInput`, and its `timeoutMs` is one deadline counted
from the write, which arriving bytes do not extend.

The **types** describing what crosses are generated, not hand-written. Every seam
type carries `#[derive(TS)] #[ts(export)]` in Rust and lands in
`apps/web/src/lib/bindings/`: `Effects`, `Wakeup`, `CloudRequest`,
`NodeDiagnostic`, `FigmaPublish`, `DesiredSub`, `BringUpEvent` /
`BringUpPhase` / `BringUpAction`, `FlashStep`, `FeedResult`.

`runtime/wasm.ts`, `board/wasm.ts` and `cloud/mqtt-subscriptions.ts`
are **re-export surfaces** — they declare no structural types of their own. Adding
a field to a seam type in Rust regenerates the TypeScript; a rename is a `tsc`
failure rather than a runtime `undefined`.

Two conventions apply at the seam:

- **`u64` needs `#[ts(type = "number")]`.** ts-rs maps `u64` to `bigint`, but these
  types cross as JSON, where `JSON.parse` yields `number`. Applied to `Wakeup::id`,
  `Wakeup::delay_ms` and `Effects::cancellations`.
- **`DesiredSub` is aliased to `ActiveSub`** at the `mqtt-subscriptions.ts`
  re-export, where the host-side vocabulary uses the latter.

## What happens when Rust fails

Every runtime entry point returns `Result<String, JsError>` — a throw on the JS
side. `runtime/runtime-bridge.ts` is the one crossing into the flow runtime;
no call site holds a runtime handle directly. Each typed entry point of the
`RuntimeBridge` returns the decoded reply or `undefined` and never throws. See
[ADR-0017](adr/0017-wasm-fault-seam.md).

| Fault | Meaning | Surface |
|---|---|---|
| `badInput` | Rust returned `Err`; module intact, this turn lost | node badge when the op names a node, else console |
| `engineBroken` | wasm trap; runtime invariants gone | board error state + toast, reactor disposed |
| `disposed` | bridge already closed | console, once |

A trap latches the bridge closed *before* the fault is routed, so nothing
re-enters a runtime whose state is indeterminate, and a deterministic fault faults
once rather than per chunk.

An undecodable reply — the call returned but `JSON.parse` failed — routes through
the same handler as a thrown fault, so the crossing has one answer rather than one
path to the seam and another to the console.

**`onClosed` means the reader ended, and nothing else.** `pumpReader`
(`board/board-link.ts`) contains `session.feed` and `onBytes` per chunk; only a
`reader.read()` that rejects or ends reaches the transport's close path. An engine fault cannot present
as an unplugged board, and auto-reconnect still fires on genuine port loss.

Not behind this seam: `session.pinsJson`, `FlashSession`, and `machine.handle` run
inside probe and flash paths where a throw already means "this probe failed",
which the bring-up machine handles.

## The inbound stream

`pumpReader` in `board/board-link.ts` fans each inbound chunk, unfiltered and
in order, to two wasm instances: the **detection codec** (`FirmataSession`) and the
flow runtime. Both wrap the same `microflow_core::firmata::FirmataClient` — one
codec answering two questions at two lifetimes, not two competing parsers. The
detection codec answers the handshake and must exist before any runtime does; the
runtime decodes for flow execution. Consistency comes from the identical stream,
not from synchronisation between them. See [ADR-0018](adr/0018-two-firmata-decoders.md)
for what would have to change for merging them to be worthwhile.

The detection codec's per-chunk report is **not** decoded on the JS side once a
flow is running — nothing consumes it, so the chunk costs one `session.feed` and no
`JSON.parse`.

## Guards

- `effects-sink.ts` is exhaustive over `keyof Effects` in two directions — a field
  added to the Rust `Effects` fails to compile until it is both ordered and
  handled.
- `runtime/effects-sink.test.ts` asserts the apply order at runtime, the twin of
  core's `context::apply_tests`.
- `runtime/runtime-bridge.test.ts` covers fault containment, the latch, and that
  a throwing runtime does not close the board connection.
- `runtime/host-input.wasm.test.ts` drives a key and a MIDI message through the
  compiled runtime module, so the browser's fan-out is checked against the same
  code the desktop runs.
- `.github/workflows/typescript.yml` runs `bun test` and `tsc --noEmit`. The
  typecheck job builds the wasm first, because the host imports the generated glue.

## Commands

```sh
cd apps/web && bun run build:wasm      # all three modules, --profile wasm-release
bun test                                # host tests (bun:test)
bun run check-types                     # tsc --noEmit, needs the wasm bindings
cargo test -p microflow-core --features runtime,cloud   # also regenerates bindings
```

`microflow-core`'s `runtime` and `cloud` are non-default features: a bare
`cargo test -p microflow-core` compiles no runtime code and passes silently.
