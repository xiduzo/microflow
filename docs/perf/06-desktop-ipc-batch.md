# Desktop IPC: one turn, one message

On desktop the runtime lives on the actor thread (`apps/web/src-tauri/src/runtime/host.rs`)
and the canvas lives in the webview. Every value a node emits has to cross that boundary.
This document records what crosses it per turn, in what order, and what a change must
preserve.

## One turn

An `ActorMsg` maps to one `FlowRuntime` entry point, which returns one `Effects`
(`host.rs:296-374`). `Actor::apply` (`host.rs:389`) hands it straight to
`Effects::apply` (`crates/microflow-core/src/runtime/context.rs:187`), which drives the
`EffectsSink` hooks in the canonical ADR-0008/0009 order:

| step | hook | desktop primitive |
| --- | --- | --- |
| 1 | `write_bytes` | `serialport::write_all` (`host.rs:405`) |
| 2 | `cancel_wakeup` | `AbortHandle::abort` (`host.rs:415`) |
| 3 | `arm_wakeup` | Tokio `sleep` task sending `ActorMsg::Wake` (`host.rs:426`) |
| 4 | `perform_cloud` | `MidiManager::send`, else `CloudPerformer` (`host.rs:437`) |
| 5 | `dispatch_events` | **one** `AppHandle::emit` (`host.rs:454`) |
| 6 | `report_diagnostic` | one `AppHandle::emit` per diagnostic (`host.rs:458`) |

Step 5 is a single IPC message regardless of how many nodes emitted: one serialize, one
IPC hop, one webview `JSON.parse` for the whole turn. A 60 Hz oscillator and everything
its fan-out cascade lights up cost one message per tick.

## Wire contract

| Tauri event | payload | emitted |
| --- | --- | --- |
| `component-events` | `ComponentEvent[]` | once per turn that has at least one event |
| `node-diagnostic` | `NodeDiagnostic` | once per diagnostic |

`ComponentEvent` and `NodeDiagnostic` are the ts-rs-generated types
(`crates/microflow-core/src/runtime/value.rs`, `context.rs:103`); see
[07-generated-wire-types.md](07-generated-wire-types.md).

The array is in emission order — the order the runtime folded the events into
`Effects::component_events` — and the webview must apply it in that order. Array index
carries meaning; `ComponentEvent::sequence` is the runtime's own stamp and is not a
substitute for position.

An empty turn emits nothing: `Effects::apply` guards on
`!self.component_events.is_empty()` (`context.rs:200`) before calling the hook, so an
idle turn costs zero IPC.

## The batch hook

`EffectsSink::dispatch_events` (`context.rs:159`) is a defaulted trait method whose
default loops `dispatch_event`. A host pays the per-event hook unless it overrides.
The desktop sink overrides it (`host.rs:454`) and routes its own `dispatch_event`
through the batch with a one-element slice (`host.rs:447`), so `component-events` is the
only shape the webview sees from this host. The browser host takes the default: its UI
hop is a store write in the same process, where batching buys nothing.

`context::apply_tests` asserts both paths observe the same events in the same order
(`batched_dispatch_delivers_the_same_events_in_the_same_order`), that a turn is one
batch, and that an eventless turn reaches neither hook
(`apply_skips_dispatch_when_no_component_events`). The canonical-order scenario runs in
the same module and is mirrored in TypeScript at
`apps/web/src/lib/firmata/__tests__/effects-sink.test.ts`.

## MIDI listener cache

Inbound MIDI (CC sweeps, aftertouch) arrives at up to ~1 kHz, and each message fans out
to every `Midi` in-node whose device filter matches. The listener list is derived state:
it changes only when the flow changes.

The actor holds it as `midi_listeners: Rc<[MidiListener]>` (`host.rs:187`).
`ActorMsg::MidiMessage` reads it through an `Rc::clone` (`host.rs:339`) — the clone is a
refcount bump, and it lets the fan-out hold the list while each `deliver_message` turn
mutates the actor.

Invalidation has exactly one site: `ActorMsg::FlowUpdate` (`host.rs:315`) rebuilds the
cache from `FlowRuntime::collect_midi_listeners` and passes the same list to
`MidiManager::reconcile` (`host.rs:316`), so the open `midir` input connections and the
routing table are always derived from one list. `ActorMsg::Connect` re-applies
`last_flow` to a fresh runtime (`host.rs:296-299`); the component set is unchanged, so
the cache stays correct without a rebuild.

## Invariants

- One turn is at most one `component-events` message. Reintroducing a per-event emit puts
  the IPC hop back on the emission hot path.
- The array order is the apply order. Anything that reorders, dedupes, or coalesces events
  inside the batch changes runtime semantics, not just transport.
- `Effects::apply` owns the sequence (ADR-0008). Transport changes belong in the sink
  hooks; the order stays in `context.rs`.
- A new `Effects` field adds a required `EffectsSink` hook. `dispatch_events` is defaulted
  *because* `dispatch_event` already covers it — a genuinely new field must not be
  defaulted, or it lands silently unhandled.
- The MIDI cache is only as correct as its single invalidation site. Any new path that can
  change the component set must rebuild it next to `MidiManager::reconcile`, not instead
  of it.
