# ADR-0043 — A timed node holds the same bounded state live and on the board

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander
- **Extends:** [ADR-0013](0013-handle-aware-sketch-wiring.md), [ADR-0033](0033-one-node-config-resolution.md)

> **Decision:** a node that holds values over time holds the same number of
> them in the live runtime and in the generated sketch, under the same rule.
> The bound is one constant in the node's `config.rs`, read by its interpret
> half (`runtime.rs`) and its emit half (`codegen.rs`). Past the bound **the
> newest pending gives way**: an arrival takes the place of the newest held
> item, so the oldest, which fires next or which a change counts from, stays.
> The **Delay** holds `DelayConfig::capacity()` triggers: one as a
> **Debounce**, `QUEUE_CAPACITY` (16) as a **Queue**. The **Trigger** holds
> `WINDOW_CAPACITY` (16) values in its **Trigger window**.

## Context

The live runtime has a heap; a board has a few kilobytes of RAM. A node whose
state grows with its input was written twice, each half with its own idea of
how much to keep, so a flow did something else once uploaded.

- **Delay.** With `forgetPrevious` off (the default) the live Delay armed a
  wakeup per trigger, but a node has one wakeup per method, so each trigger
  replaced the last and only the latest fired. The sketch had one timer slot
  and kept the first pending trigger, ignoring the rest. Neither did what the
  setting says, and they disagreed with each other.
- **Trigger.** The sketch compared each value with one baseline and ignored
  `within`. The live Trigger held every value of its window with no bound.

A bound on the board is not optional, and a live node that keeps more than the
board can hold behaves differently there. So the bound belongs to the node, not
to a host.

## Decision

**D1 — One bound, in the node's config.** The number of held items is a
constant (or a function of the settings) in `nodes/<node>/config.rs`, beside
the config both halves resolve ([ADR-0033](0033-one-node-config-resolution.md)).
The runtime sizes its queue from it; the emitter sizes the sketch's arrays from
it. No half has a literal of its own.

**D2 — The newest pending gives way.** When an item arrives and the node is
full, it replaces the newest held item. The oldest items keep their place and
their time. For a Delay that means the triggers that fire next still fire on
time and the latest trigger is never the one lost; with one slot the same rule
is debounce. For a Trigger it means the value a change counts from stays put
while a burst arrives.

**D3 — Delay: a queue, or a debounce.** `DelayConfig::capacity()` is 1 when
`forgetPrevious` is on and `QUEUE_CAPACITY` (16) when it is off.

- **Queue:** every trigger fires `delay` ms after it arrived, in arrival order,
  on `event`, carrying the value it arrived with.
- **Debounce:** only the latest trigger fires, `delay` ms after it arrived.
- Live, the Delay keeps one `_tick` wakeup armed for the oldest pending
  trigger. A wakeup that finds several due fires them all in that turn, oldest
  first. The sketch keeps a ring of `capacity` slots, each a `double` value and
  an `unsigned long` arrival time, compares `millis()` without blocking, and
  fires at most one trigger per `loop()`: triggers due together fire on
  consecutive iterations, in order.
- Live, a queue that drops a trigger raises one warning on the node, and the
  warning comes down when the queue has drained or the Delay is built again. A
  debounce never warns, since it drops by design. The sketch has nowhere to
  report and does not warn.
- A flow update that leaves the Delay unchanged keeps its pending triggers. A
  Delay whose settings change is built again and starts empty, and a wakeup
  armed by the Delay it replaced fires nothing.

**D4 — Trigger: a bounded window.** The Trigger holds the values that arrived
in the last `within` ms, at most `WINDOW_CAPACITY` (16), each with its arrival
time on the engine clock ([ADR-0045](0045-core-time-is-the-engine-clock.md)).
A new value is compared with the oldest one held; when it has moved the set way
by `threshold` (or `threshold` percent, when `relative`) the Trigger bangs,
carrying the value. It then stays triggered and does not bang again until a
value moves the other way: once per crossing. The sketch holds the same ring
(`double` value, `millis()` arrival), lets values older than `within` go with
the same strict comparison, and bangs under the same rule. The Trigger arms no
wakeups; a held value is only looked at when a new one arrives.

## Considered options

- **Unbounded live, bounded on the board.** The live flow would be the one the
  user tests and not the one they upload.
- **The oldest gives way.** A Delay would lose the trigger about to fire and a
  Trigger would lose the value a change counts from, so a burst would move the
  baseline under the user.
- **Refuse new items when full.** A Delay would lose the latest trigger, which
  in a debounce is the one that matters; the queue and the debounce would need
  two rules.
- **A bound per host.** The bound is a fact of the node and its settings; a
  host-level number would let the two halves drift again.

## Consequences

- A stored flow with a Delay whose `forgetPrevious` is off or unset fires every
  trigger, live and on the board, up to 16 waiting. A flow that relied on only
  the latest trigger firing needs debounce turned on.
- A queue Delay costs about 130 bytes of RAM on an Uno; a Trigger about the
  same. A sketch with many of them can run out of RAM on a small board.
- The sketch carries a number: a Delay or Trigger value is a `double` there,
  and text reads as `0.0`, as on every numeric port. Live, a Delay passes on
  any value.
- A queue under steady overload is visible only live (the node warning). On
  the board it drops triggers silently.
- `parity.rs` holds the halves to the shared capacity
  (`delay_plumbs_config_into_the_deadline`); each half's own tests cover the
  rule.

## What this does NOT decide

- The state of other nodes. A node whose held state grows with its input
  follows this rule when it is written.
- Whether the bound should be a setting. It is a constant.

## References

- `crates/microflow-core/src/nodes/delay/config.rs` — `QUEUE_CAPACITY`, `DelayConfig::capacity`.
- `crates/microflow-core/src/nodes/delay/runtime.rs`, `codegen.rs` — the live queue and the sketch's ring.
- `crates/microflow-core/src/nodes/trigger/config.rs` — `WINDOW_CAPACITY`.
- `crates/microflow-core/src/nodes/trigger/runtime.rs`, `codegen.rs` — the live window and the sketch's ring.
- `crates/microflow-core/src/codegen/parity.rs` — `delay_plumbs_config_into_the_deadline`, `trigger_emit_covers_every_behaviour`.
- `CONTEXT.md` § Queue (Delay), Debounce (Delay), Trigger window.
