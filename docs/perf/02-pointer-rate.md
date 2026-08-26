# Pointer-rate work

Pointer events arrive at roughly 120Hz — twice the frame rate, and far faster
than any document, socket or storage write should run. This note states which
state is allowed to move at that rate, which is coalesced to a frame, and what
bounds the windows on the durable side.

## The rule

Three tiers, in order of how fast they are allowed to move:

1. **Ephemeral** — lives in the React snapshot only, never in the Y.Doc.
   Drag positions, node placement positions, `selected` / `dragging` flags.
   [ADR-0004](../adr/0004-react-flow-bridge.md) owns this rule;
   `ReactFlowBridge.classifyNodeChange` is where it is decided.
2. **Frame-coalesced** — recomputed or transmitted at most once per
   `requestAnimationFrame`, always carrying the latest value, never a queue.
   Handle proximity, cursor awareness, structural flushes to the Y.Doc.
3. **Durable** — the Y.Doc, `localStorage`, the server's room store. Written
   on commit, or inside an explicitly bounded window. Never per pointer event.

Nothing in tier 3 may be reached directly from a pointer handler.

## Where each tier is enforced

### Handle proximity — one listener, one frame, pure geometry

`apps/web/src/components/flow/handle-proximity.ts` is the single pointer
source for the hover affordance on handles.

- One `window` `mousemove` listener for the whole canvas, added with the first
  subscriber and removed with the last (`handle-proximity.ts:131`).
- The listener only records the latest pointer and schedules one frame;
  `flushProximity` (`handle-proximity.ts:108`) does the work.
- Proximity is pure geometry over flow coordinates ReactFlow already holds —
  node position and measured size — so no handle measures the DOM.
  `isHandleNearPointer` (`handle-proximity.ts:65`) is a pure function and is
  unit-tested without a DOM in
  `apps/web/src/components/flow/__tests__/handle-proximity.test.ts`.
- The affordance radius `PROXIMITY_RADIUS` (`handle-proximity.ts:21`) is a
  constant in **flow** units: screen distance and the screen radius both scale
  with zoom, so they cancel. Zoom only decides whether the affordance is on at
  all (`PROXIMITY_MIN_ZOOM`).
- Subscribers are told the boolean only when it flips, so a frame in which
  nothing changes costs zero renders.
- One canvas is mounted per document (ADR-0004), so the flush converts the
  pointer to flow space once per frame using any subscriber's viewport. A
  second canvas would need per-canvas grouping.

`apps/web/src/components/flow/handle.tsx:30` (`useHandleProximity`) is the
React adapter: it subscribes, reads the node from the ReactFlow store, and
returns a boolean.

### Handle edge subscriptions — boolean selectors

A handle cares about the edges attached to it, not about the edge array.

- `handle.tsx:77` — "is this handle selected via an edge" is a `useStore`
  selector returning a boolean, so the handle re-renders only when its own
  answer flips.
- `handle.tsx:91` — `isConnectable` likewise resolves to a boolean inside the
  selector.
- `isValidConnection` reads `getEdges()` lazily at call time and holds no
  subscription at all.

### Cursor awareness — one frame, one wire frame

- `apps/web/src/components/flow/react-flow-canvas.tsx:77` records the latest
  pointer and converts it to flow coordinates once per animation frame; the
  conversion measures the canvas container, so it must not run per event.
- `packages/collab/src/sync-provider.ts:373` (`updateCursor`) keeps the latest
  cursor locally and pushes it into awareness — and therefore onto the
  socket — at most once per frame. Both the awareness re-encode and the
  awareness observer fan-out are bounded by that. The pending frame is
  cancelled in `destroy` (`sync-provider.ts:434`).

### Node placement — ephemeral until commit

`apps/web/src/components/flow/dialogs/new-node-dialog.tsx`:

- While the user moves a freshly added node, the position is pushed through
  `onNodesChange` as a `position` change with `dragging: true`
  (`new-node-dialog.tsx:321`) — the exact path `ReactFlowBridge` classifies as
  ephemeral — and coalesced to one per frame.
- The position is held in a ref, not in the document.
- Commit (`new-node-dialog.tsx:267`) writes the final position and the
  deselect in a single `updateNode`, so the whole placement is one CRDT
  transaction and one undo entry.
- Escape / Backspace removes the node and drops the ref.

### localStorage mirror — bounded write rate, flush on teardown

`apps/web/src/session/local-storage-sync-adapter.ts`:

- `setItem` is synchronous and blocks the main thread, so the **write** rate is
  bounded, not the change rate: at most one write per `WRITE_INTERVAL_MS`
  (`local-storage-sync-adapter.ts:11`).
- Leading edge (`local-storage-sync-adapter.ts:81`): the first change of a
  quiet period is written immediately; further changes in the window collapse
  into one trailing write.
- `destroy` (`local-storage-sync-adapter.ts:68`) clears the timer and writes
  synchronously, so an unload never loses the tail of a burst.

### Server persistence — quiet period with a deadline

`packages/collab/src/yjs-server.ts:403` (`schedulePersist`):

- A room is persisted after `persistDebounce` of quiet, **or** at
  `dirtySince + persistMaxWait`, whichever comes first. Sustained editing keeps
  resetting the quiet-period timer, so the deadline is what bounds how much
  unsaved work a room can hold (default 10s, `yjs-server.ts:125`).
- `dirtySince` is cleared on a successful persist; a failed persist leaves the
  room dirty and its deadline standing.

Known ceiling: each persist encodes and stores the whole document blob
(`Y.encodeStateAsUpdate`), so persist cost scales with document size, not with
the size of the change. Lowering `persistMaxWait` trades write volume against
staleness on that ceiling.

## Invariants a change must not break

- No pointer handler writes to the Y.Doc, to `localStorage`, or to a socket.
- No proximity or hover code calls `getBoundingClientRect`, `offsetWidth`, or
  any other layout-forcing read on a per-event or per-handle path.
- Per-handle listeners stay out: a new affordance subscribes to the shared
  pointer source rather than adding its own `window` listener.
- A handle subscribes to booleans, never to the edge or node arrays.
- `screenToFlowPosition` measures the container — call it at most once per
  frame, never once per subscriber or per event.
- The proximity radius stays expressed in flow units; reintroducing a
  zoom-scaled screen threshold double-counts zoom.
- Anything coalesced to a frame carries the *latest* value and cancels its
  pending frame on teardown; it never queues per-event work.
- Every debounce on a durable write has a bound: either a max-wait, or a
  synchronous flush on teardown, or both.
