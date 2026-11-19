# ADR-0037 — Core owns host-input fan-out; hosts keep the devices

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander

> **Decision:** a **host input** is a key or a MIDI message a Runtime Host read
> off a device. The host hands it to core raw — an accelerator and a pressed
> flag, or a port name and the message bytes — and core decides which nodes hear
> it, in which order, in one turn. A host never holds a node id for an input.
> What a host must have open is asked of core as a yes or no answer, never
> handed over as a listener list for the host to interpret.

## Context

Pins and I2C always worked this way: the host moves bytes, and the runtime's
own listener tables decide which nodes a reading reaches. Keys and MIDI did not.
Each host picked the listening nodes itself, and the two did not pick alike.

**Keys.** The desktop forwarded a `key_event` to the actor, which called
`FlowRuntime::dispatch_key_event`; core matched the accelerator
case-insensitively and ran one turn. The browser had no such call. A React hook
(`runtime/use-hotkey-events.ts`) built its own `accelerator → node ids` map from
the node catalog and dispatched `key_event` into the wasm runtime once per node:
one turn per listener, grouped by the exact spelling of the accelerator, in the
order the document listed the nodes. The same flow and the same key press gave
one `Effects` on one host and several on the other.

**MIDI.** Core exported `collect_midi_listeners()`, a list of
`MidiListener { node_id, device_name }`, with a ts-rs binding and a
`midiListeners` op on the `RuntimeBridge`. Each host cached the list, matched
port names against the device filters with its own copy of the substring rule
(`device_matches` in the desktop's `midi.rs`, `deviceMatches` in
`midi-performer.ts`, kept alike by a comment), and called `deliver_message` once
per matching listener. One message to three nodes was three turns, three
`Effects` and, on the desktop, three IPC batches to the webview. The desktop
actor also had to rebuild its cached list at every point a flow could change,
including a respawn.

Fan-out is policy: who listens, in what order, and what one listener's runaway
cascade costs the others. Held per host, it was written twice and tested twice,
and the order was whatever each host's collection happened to iterate in.

## Decision

**D1 — Two entry points take a raw input.** `FlowRuntime::dispatch_key_event(accelerator, pressed)`
and `FlowRuntime::dispatch_midi_message(port_name, bytes)`
(`crates/microflow-core/src/runtime/host_input.rs`) each return one `Effects`.
Neither takes a node id. An input no node listens for is an empty turn.

**D2 — The listener tables are built from Listener Wiring.** A node declares
`ListenerWiring::HotKey { accelerator }` or
`ListenerWiring::MidiInput { device_name }` (`runtime/wiring.rs`); the Hotkey
node lowercases its accelerator in its wiring. `update_flow` gathers them
(`gather_wiring`, `runtime/reconcile.rs`) into `key_listeners` (accelerator to
node ids) and `midi_listeners` (node id and folded device filter), both sorted
by node id. Several nodes on one key or one device all hear it;
there is no one-owner reconcile as there is for a broker topic.

**D3 — Listeners hear an input one at a time, in node-id order, in one turn.**
Each listener's cascade settles before the next listener hears the input
(`finish_fed` in `runtime/mod.rs`). The listeners share the turn's `Effects` and
nothing else: each cascade has the whole [Turn budget](../../CONTEXT.md#turn-budget),
so one that runs away is stopped and badged on its own and the listeners after
it still hear the input; and each listener's timer requests are resolved before
the next is fed, so a timer one arms and a later one cancels is not left armed.

**D4 — Hosts ask what is wanted.** `FlowRuntime::listens_to_midi()` answers
whether the flow has any MIDI interest (a browser asks for Web MIDI access only
then) and `FlowRuntime::wants_midi_input(port_name)` whether one port should be
open. `midi_device_matches(port_name, filter)` is the one device-name rule
behind both — a case-insensitive substring, the empty filter passing every port
— and the rule a host applies to its output ports for a `MidiSend`. The filter
list itself never leaves core.

**D5 — A host owns device I/O and nothing else.** The desktop's `MidiManager`
(`apps/web/src-tauri/src/runtime/midi.rs`) opens and closes `midir` ports
against D4's answers after every flow update and after a respawn, and forwards
each message as `ActorMsg::MidiMessage { port_name, bytes }`. The browser's
`MidiPerformer` (`apps/web/src/runtime/midi/midi-performer.ts`) does the same
over Web MIDI through an injected `MidiRuntime`. Keys: `hotkeyAccelerators`
(`apps/web/src/runtime/hotkey-accelerators.ts`) lists the accelerators to
register, one per case-insensitive identity and no node ids, and
`useHotkeyEvents` sends each press and release through the host's door (a Tauri
`key_event` on the desktop, which the actor receives as `ActorMsg::Key`; in the
browser the board controller's `keyEvent`, which reaches `RuntimeBridge.keyEvent`
through the flow reactor).

**D6 — The wasm surface mirrors core, op for op.** `RuntimeBridge` exposes
`keyEvent`, `midiMessage`, `listensToMidi`, `wantsMidiInput` and
`midiDeviceMatches` (`keyEvent` and `midiMessage` also take the host's `nowMs`).
All five are whole-flow ops with no node id.

## Considered options

- **Keep handing hosts the listener list.** It is one binding and no new entry
  point, but it leaves the matching rule, the order and the turn boundaries in
  two languages, which is where they drifted.
- **One turn per listener, made by core.** Simple, but a key heard by five nodes
  is then five `Effects` and five IPC batches, and a host can observe the flow
  half-way through one input.
- **One shared budget for the whole input.** Cheaper to reason about, but the
  first listener's runaway loop would cost every later listener the input.

## Consequences

- Both hosts fan out identically by construction. `host_input::tests` pin the
  order, the per-listener budget and the timer cases; `host.rs` pins one IPC
  batch per input on the desktop; `host-input.wasm.test.ts` pins the same
  behaviour through the compiled wasm module.
- A turn started by a host input can drain more than `TURN_BUDGET` events: up to
  one budget per listener. A host cannot assume a turn's event count is bounded
  by the budget alone.
- A fault on `keyEvent` or `midiMessage` names no node. In the browser a
  rejected key goes to the console, not to a Hotkey node's badge
  ([ADR-0017](0017-wasm-fault-seam.md), amendment).
- The device-name rule crosses the wasm boundary for every output port of a
  `MidiSend` and every input port of a reconcile. Those are per flow update and
  per send, not per message, so the cost is accepted.
- Which accelerators to register is read from the flow document in the
  webview (the Host Adapter's `accelerator`), because the keyboard listener
  lives there. Core is not asked for it. The two can disagree only about a
  Hotkey node the runtime could not build, whose key is then registered and
  heard by nobody.
- MIDI channel and mode filtering stay in the node (`receive_raw_message`): the
  fan-out picks listeners by port, the node decides what to do with the bytes.

## What this does NOT decide

- Hot-plug policy. The browser re-attaches on `onstatechange`; the desktop
  reconciles ports on a flow update and a respawn only.
- MIDI output. A `MidiSend` stays a `CloudRequest` the host performs; only its
  device-name rule is shared.
- Pin and I2C routing, which already live in core.
- Any other host input (gamepad, pointer). A new kind is a new `ListenerWiring`
  variant and a new entry point over the same `fan_out`.

## References

- `crates/microflow-core/src/runtime/host_input.rs` — the entry points, the desired-state answers, `midi_device_matches`, the fan-out tests.
- `crates/microflow-core/src/runtime/wiring.rs` — `ListenerWiring::HotKey`, `ListenerWiring::MidiInput`.
- `crates/microflow-core/src/runtime/reconcile.rs` — the listener tables.
- `crates/microflow-core/src/runtime/mod.rs` — `finish_fed`.
- `crates/microflow-runtime-wasm/src/lib.rs`, `apps/web/src/runtime/runtime-bridge.ts` — the wasm ops.
- `apps/web/src-tauri/src/runtime/midi.rs`, `apps/web/src-tauri/src/runtime/host.rs` — `MidiManager`, `ActorMsg::Key`, `ActorMsg::MidiMessage`.
- `apps/web/src/runtime/midi/midi-performer.ts`, `apps/web/src/runtime/hotkey-accelerators.ts`, `apps/web/src/runtime/use-hotkey-events.ts` — the browser's device I/O.
- [ADR-0006](0006-rehost-runtime-on-core.md) — the `Effects` seam; [ADR-0008](0008-effects-apply-policy.md) — how a host applies the one `Effects`.
- `CONTEXT.md` § Host input, Wiring, Turn budget.
