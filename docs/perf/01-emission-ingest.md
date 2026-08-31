# Emission ingest and the signal clock

Every runtime **Emission** reaches the canvas through one function:
`applyComponentEvent` (`apps/web/src/lib/event-ingest.ts:28`). Both hosts funnel
through it — the browser wasm reactor at
`apps/web/src/lib/firmata/flow-reactor.ts:284`, and the desktop IPC listener at
`apps/web/src/hooks/use-component-events.ts:36` — so node values, wire
animation, and the devtools dev-log stay in lock-step across platforms.

It is a hot path. Three sensors sampled at the board's ~19 ms interval plus a
60 Hz oscillator put it in the low hundreds of calls per second, on a canvas
whose edge and node counts grow without bound.

## The guarantee

**One Emission costs its emitting node's fan-out, not the size of the flow.**

Nothing inside the funnel scans a whole collection:

| Step | `event-ingest.ts` | Cost |
| --- | --- | --- |
| Store the node value | `:31`, `:33` | one map write, one node woken per frame |
| Animate the wires | `:37` | one hash lookup, then one write per outgoing edge |
| Feed the dev-log | `:42` | one push onto a pending buffer |

## The edge index

`applyComponentEvent(event, edges)` takes the flow's edge array, but never walks
it. `edgeIndexOf` (`apps/web/src/lib/ingest/edge-index.ts:44`) turns it into an
`EdgeIndex` — a `(source, sourceHandle) -> edge ids` map (`edge-index.ts:13`),
the UI mirror of the runtime router's `EdgeMap`
(`crates/microflow-core/src/runtime/router.rs:66`). `edgeIdsFor`
(`edge-index.ts:35`) answers the fan-out question with a single hash lookup, and
returns a shared empty array for an unwired handle.

Ownership and rebuild rule: **the index belongs to the edge array's identity.**
`edgeIndexOf` caches it in a `WeakMap` keyed on that array (`edge-index.ts:42`),
so a new array — which is what a flow change produces — is a rebuilt index, and
a burst of events on an unchanged flow reuses one.

Both hosts therefore hand ingest a *stable* array:

- The browser reactor keeps `this.edges`, replaced only when a flow is loaded.
- The desktop hook holds `edgesRef` (`use-component-events.ts:25`), refreshed
  from `doc.getEdges()` inside a `doc.onEdgesChange` observer
  (`use-component-events.ts:28`) — never per event.

Keys are `source`, a NUL byte, then the handle (`edge-index.ts:18`), so
`("ab", "c")` and `("a", "bc")` cannot collide. Edges without an id are skipped:
there is nothing to animate.

## Node values

`nodeDataStore` (`apps/web/src/stores/node-data.ts:72`) is a plain `Map` of
`node id -> latest value` (`node-data.ts:20`), plus `id:handle` keys for
side-channels such as the LLM `thinking` flag. Each key carries its own listener
set (`node-data.ts:21`), so `update` writes one entry and wakes only the node
reading that key. `useNodeValue` / `useNodeHandleValue` read it through
`useSyncExternalStore` (`node-data.ts:97`).

The write lands immediately; the **wake** is deferred to the next frame. Keys
written since the last publish are buffered in `pending` (`node-data.ts:24`) and
flushed together (`node-data.ts:33`). This matters because each Emission arrives
in its own task — one Tauri IPC callback on the desktop, one `Effects` per
`feedBytes` return in the browser — so React has nothing to batch them with, and
a hundred-event burst on one sensor would otherwise cost that node a hundred
renders. Because the map only ever holds the latest value per key, the frame
publishes the newest one and never a stale intermediate.

The default value passed by a node is pinned on first render (`node-data.ts:96`)
and applied *outside* the snapshot. Callers pass fresh object literals — an RGBA
colour, a pixel grid — and a snapshot whose identity changes on every read would
loop.

## The dev-log

`useDevLogStore.record` (`apps/web/src/stores/dev-log.ts:96`) takes a message
that is either a string or a **thunk**. Ingest passes a thunk
(`event-ingest.ts:45`): the string, and the `formatComponentValue` call behind
it, are built the first time the panel reads that row and memoised thereafter
(`dev-log.ts:62`). Rows the panel never shows are never formatted, and a paused
log formats nothing at all.

`DevLogEntry.message` stays a plain `string` to every reader — the thunk is
hidden behind a getter, so the devtools panel is unaware of it.

Records land in a pending buffer and reach React in batches every
`FLUSH_INTERVAL_MS` (`dev-log.ts:29`, flushed at `dev-log.ts:66`). Every store
here disarms its pending flush in `clear` — a live handle would block the next
write from re-arming one, leaving the canvas frozen on stale values. The
newest-first `entries` array is rebuilt once per flush and capped at
`MAX_ENTRIES` (`dev-log.ts:26`), not once per Emission.

## The signal clock

Wire animation is driven by **one** clock, owned by the signal store
(`apps/web/src/stores/signal.ts`), not by a timer per edge.

- `frames` (`signal.ts:22`) holds an entry only for edges with at least one live
  signal — a `SignalFrame` of `{ signals, now }`.
- `addSignal` (`signal.ts:82`) appends to that edge's frame and schedules the
  clock if it is not already running. It deliberately does **not** wake the edge
  itself: one flow turn can fire dozens of signals down one wire, each in its
  own task, and the clock below publishes them together on the next frame —
  which is the soonest the animation could show them anyway.
- `tick` (`signal.ts:57`) samples `now` once, drops signals older than
  `SIGNAL_DURATION` (`signal.ts:9`), notifies the edges it touched, and
  reschedules **only while `frames` is non-empty** (`signal.ts:69`). The last
  expiring signal stops the clock.
- The scheduler is `requestAnimationFrame` in the browser and a timer elsewhere
  (`signal.ts:34`), so the store is usable under test and SSR.

An idle canvas therefore runs no timers and commits no state. An edge with no
live signal has no frame, is woken by no other edge's traffic, and draws a
static path.

`AnimatedEdge` (`apps/web/src/components/flow/edges/animated-edge.tsx:10`) reads
its frame with `useEdgeSignals` and renders dots at
`signalPositions(signals, now, bezierPoints)` (`animated-edge.tsx:44`) — a pure
function of the frame the store handed out, checked directly in
`apps/web/src/components/flow/edges/__tests__/signal-positions.test.ts`. The
bezier control points are parsed once per path change
(`animated-edge.tsx:27`), never per frame.

## Desktop delivery

The desktop host emits `component-event` for a single event and
`component-events` for a batch. `useComponentEvents` listens to both
(`use-component-events.ts:33`, `:40`) and puts every event through the same
`applyComponentEvent`; a batch is a loop, not a second code path. See
[06-desktop-ipc-batch.md](06-desktop-ipc-batch.md) for what the backend
guarantees about batch contents and ordering.

## Invariants

1. `applyComponentEvent` never iterates the edge array, the node-value map, or
   the dev-log entries. Anything proportional to flow size belongs in the index
   build, not the funnel.
2. Callers pass a **stable** edge array that changes identity only when the flow
   changes. Passing a freshly built array (`doc.getEdges()`, `.map`, `.filter`)
   per event rebuilds the index every time and silently restores the O(edges)
   cost.
3. A store write wakes only the keys it touched, and at most once per frame.
   New per-node or per-edge state gets its own listener set; a single global
   version counter would wake the whole canvas. The counts are asserted in
   `apps/web/src/components/flow/__tests__/render-budget.test.tsx`, which
   delivers each event in its own task so it measures the store rather than
   React's own batching.
4. Anything expensive to render as text is recorded as a thunk, never a
   pre-formatted string.
5. There is exactly one clock. It starts when the first signal is added, stops
   itself when the last one expires, and no component may schedule its own
   interval or animation frame for signal animation.
6. `signalPositions` stays pure in `(signals, now, points)`. Reading the clock,
   `Date.now()`, or component state from inside it makes the animation
   untestable and frame-dependent.

## Verifying

```sh
bun test                                   # includes the edge-index and signal-position suites
cd apps/web && bunx tsc --noEmit
```
