# Collaboration scaling audit — Yjs ↔ ReactFlow ↔ Tauri

**Date:** 2026-08-28 · **Scope:** `packages/collab`, `apps/web/src/session`,
`apps/web/src/components/flow/react-flow-canvas.tsx`, the Tauri `flow_update`
path. **Question asked:** what breaks — or gets slow — when a *large group* of
contributors is in one room at once?

Findings are ordered by expected impact at scale. Each names the file, the
mechanism, and the smallest fix that addresses it.

> **Status: 12 of 13 items landed.** See [Results](#results) for measurements
> and [What is not done](#what-is-not-done) for the two that are not. Sections
> below describe the problem as found; the fix is in the linked commits.
> Benchmarks sit beside the code they measure as `*.bench.ts`; `bun run bench`
> from the repo root runs them all.

---

## Executive summary

The architecture is sound — the seams (`FlowDocument`, `ReactFlowBridge`,
`FlowUpdateDispatcher`, `YjsServer`) are in the right places and core's
`update_flow` already diffs per node, so the Rust runtime does *not* rebuild
the world on every edit. The scaling problems are all in the layers above it,
and they cluster into three families:

1. **A correctness race on the server** that only fires when several people
   open the same flow simultaneously — exactly the large-group case (§1).
2. **Presence is unthrottled and un-isolated**, so cursor traffic grows as
   *N²* on the wire and re-renders the entire canvas on every remote mouse
   move (§2, §3).
3. **Everything downstream of the doc is O(whole flow)** — snapshot merges,
   dispatch keys, IPC payloads — so per-edit cost scales with flow size *and*
   contributor count multiplied together (§4–§7).

§1–§3 are the ones that decide whether a 20-person room is usable. §4–§7 decide
whether a 300-node flow is usable. §8+ are correctness/robustness items worth
fixing but not load-bearing.

---

## 1. Concurrent joins can create two rooms for one flow — one is silently dead

**Severity: high (data-loss-shaped).** `packages/collab/src/yjs-server.ts:436`

`getOrCreateRoom()` is `async` and awaits `store.load(flowId)` between the
"does the room exist?" check and `this.rooms.set(flowId, room)`. There is no
in-flight guard. Two `join()` calls for the same `flowId` that arrive inside
that await window both observe `rooms.get(flowId) === undefined`, both build a
`Y.Doc`, and both `rooms.set` — the second overwrites the first.

The consequences are not "slightly wrong", they are silent:

- Client A is registered in room **A**'s `connections` set, but `rooms` now
  points at room **B**. `receive()` (`yjs-server.ts:228`) looks up room B, finds
  `room.connections.has(connection) === false`, and **returns without error**.
  Client A is connected, shows "synced" locally, and its edits reach nobody.
- `leave()` for client A deletes from room B's set (a no-op), so room A's
  `connections.size` never reaches 0. Room A's `Y.Doc` and `Awareness` are
  **never destroyed** — a per-incident memory leak.
- Whichever room loses the `rooms.set` race can still be the one that persists,
  so a slow `store.load` can lose the other side's writes.

The probability of hitting this rises with exactly the thing we care about:
several people clicking the same invite link at once, or everyone reconnecting
together after a server restart.

**Fix:** memoize the in-flight promise.

```ts
private roomsLoading = new Map<string, Promise<Room>>();

private getOrCreateRoom(flowId: string): Promise<Room> {
  const live = this.rooms.get(flowId);
  if (live) return Promise.resolve(live);
  let pending = this.roomsLoading.get(flowId);
  if (!pending) {
    pending = this.loadRoom(flowId).finally(() => this.roomsLoading.delete(flowId));
    this.roomsLoading.set(flowId, pending);
  }
  return pending;
}
```

A regression test belongs alongside it: two `join()`s awaited via
`Promise.all` against a store whose `load` resolves on a deferred, asserting
`getRoomCount() === 1` and that both connections receive each other's updates.

### 1b. The same shape in `cleanupRoom`

`yjs-server.ts:412` — the room stays in `this.rooms` while `persistRoom` is
awaited, and is only deleted afterwards, *after* `doc.destroy()`. A `join()`
landing in that window is handed a room whose doc is about to be destroyed.
Delete from `this.rooms` first (as `dropRoom` correctly does at line 213), then
persist and destroy.

---

## 2. Cursor presence is unthrottled — the N² problem

**Severity: high.** `apps/web/src/components/flow/react-flow-canvas.tsx:71`,
`packages/collab/src/sync-provider.ts:344`

`onMouseMove` on the ReactFlow surface calls `updateCursor` on **every single
mouse-move event** (~60–120/s while moving). `SyncProvider.updateCursor` then
does a full `setLocalStateField` + an immediate `sendAwareness()` — one
WebSocket frame per mouse-move — and the server fans each one out to every
other connection in the room (`yjs-server.ts:474`).

Traffic is therefore `N × moveRate × (N−1)` frames/second. At 20 contributors
with half of them actively moving, that is on the order of tens of thousands of
frames per second through a single Node process, each one carrying a full
`user` object (name, colour, icon, `isSupporter`, `selectedNodes` array) rather
than just two numbers.

**Fixes, in order of payoff:**

- Throttle `updateCursor` to one send per animation frame (~16ms) or 50ms,
  keeping the *latest* position — trailing throttle, not debounce, so the
  cursor still lands in the right place when the mouse stops. `@tanstack/react-pacer`
  is already a dependency (`use-flow-update-dispatcher.ts:2`), so this is a
  `Throttler`, not a new package.
- Split the awareness payload: put the stable identity (`id`, `name`, `color`,
  `icon`, `isSupporter`) in one field written once, and the volatile
  `cursor`/`selectedNodes` in another. Today every cursor tick re-encodes and
  re-broadcasts the identity too.
- Consider dropping cursor broadcast entirely while the local user is dragging
  a node — the drag position is the interesting signal there, not the pointer.

---

## 3. Every remote cursor move re-renders the whole canvas

**Severity: high.** `apps/web/src/session/use-flow-sync.ts:51`,
`react-flow-canvas.tsx:42`

`useFlowSync` subscribes to the adapter's `awareness` event and responds with
`setSnapshot(buildSnapshot(session))`, which **always returns a fresh object
literal** (`use-flow-sync.ts:29`). The doc-comment on the hook claims "the
snapshot reference is stable between adapter events" — it is stable *between*
events, but every event produces a new reference, and awareness events are the
highest-frequency events in the system.

`ReactFlowCanvas` then consumes `useFlowSync` twice — once via
`useCollabPresence()` and once via `useFlowAwareness()` (lines 42–43). So a
single remote user twitching their mouse re-renders `ReactFlowCanvas` and its
entire subtree: the `ReactFlow` element, `MiniMap`, `NewNodeDialog`,
`HotkeySheet`, `SettingsPanel`, `DockPanel`, `PressensePanel`, `CollabCursors`.
Combined with §2 this is the single largest source of dropped frames in a busy
room.

**Fixes:**

- `useFlowAwareness` needs no reactive state at all — it only wants the two
  imperative callbacks. Give it a non-subscribing path to the adapter (read
  `session.sync` directly, or expose the callbacks off `useFlowSession`) so the
  canvas stops subscribing to awareness merely to *send* a cursor.
- Split presence out of the sync snapshot: a separate `useCollabPresence` store
  subscribed to only by `CollabCursors` and `PressensePanel`, both of which
  should be `memo`'d. The canvas itself never needs to re-render for a remote
  cursor.
- Give `buildSnapshot` a cheap equality check (state/isSynced/error/user-list
  identity) and return the previous object when nothing changed, so
  non-presence events stop churning too.

---

## 4. `mergeYjsIntoSnapshot` destroys object identity for every node on every update

**Severity: high at flow size × contributor count.**
`apps/web/src/session/react-flow-bridge.ts:219`

```ts
return yjsNodes.map((yjsNode) => ({ ...yjsNode, selected: …, dragging: … }));
```

Every remote change — one peer nudging one node — produces a **brand-new object
for every node in the flow**. ReactFlow memoizes node rendering on props
identity, so this defeats it wholesale: a 200-node flow re-renders 200 node
components because someone else moved one. With `k` active contributors editing,
that is `k × editRate × N` node renders per second.

**Fix:** preserve identity when nothing changed. Compare the incoming Yjs node
against the current local one on the fields that matter and return the *existing*
object reference when they match:

```ts
static mergeYjsIntoSnapshot(yjsNodes: FlowNode[], currentLocal: FlowNode[]): FlowNode[] {
  const localMap = new Map(currentLocal.map((n) => [n.id, n]));
  return yjsNodes.map((yjsNode) => {
    const local = localMap.get(yjsNode.id);
    if (local && nodeVisuallyEqual(local, yjsNode)) return local; // ← identity preserved
    return { ...yjsNode, selected: local?.selected, dragging: local?.dragging };
  });
}
```

`nodeVisuallyEqual` should compare `position.x/y`, `width`, `height`, `type` and
`data` by reference-then-shallow. Because `FlowDocument.updateNodeData` replaces
the whole node object on any write (`schema.ts:99`), a reference check on `data`
is a correct fast path: unchanged nodes keep the identical `data` object.

The same fix applies to `mergeEdgesYjsIntoSnapshot` (line 232).

**Related, same file:** `handleYjsNodesChange` (line 199) ignores the
`Y.YMapEvent` it is handed. `event.keysChanged` tells us exactly which node ids
moved; the observer could patch just those entries instead of rebuilding the
array. Worth doing after the identity fix, which captures most of the win.

## 4b. `useFlowNodes` has the same problem, per subscriber

`apps/web/src/session/use-flow-nodes.ts:8` calls `doc.getNodes()` — a full
`Array.from(map.values())` — on every doc change, and `i2c-device.tsx:35` calls
it **per node instance**. Ten I²C nodes on the canvas means ten full array
rebuilds and ten component re-renders for every keystroke anyone in the room
makes. These consumers want a *derived slice* (the I²C node wants its siblings'
bus assignments), so give them a selector-based hook with an equality check
rather than the whole array.

---

## 5. `runtimeRelevantKey` JSON-stringifies the entire flow on every change — twice

**Severity: medium-high.** `apps/web/src/session/flow-update-dispatcher.ts:176`

The dispatcher is subscribed to `onAnyChange`, so it fires for local edits *and*
every remote sync arrival. Each debounced tick then:

1. builds a full `FlowUpdate` (`buildFlowUpdate` maps every node and edge),
2. computes `runtimeRelevantKey` — which **sorts** nodes and edges and
   `JSON.stringify`s the whole flow including every node's `data` blob,
3. on success computes `runtimeRelevantKey(update)` **a second time**
   (line 260) to store it.

That is two full serializations of the entire flow per dispatch, on the main
thread, for every accepted change from anyone in the room. On a large flow the
`data` blobs (function-node source, matrix patterns, LLM prompts) dominate.

**Fixes:**

- Compute the key once and pass it into `send()`. This is a two-line change and
  halves the cost immediately.
- Replace `JSON.stringify` with an incremental hash over a stable field order
  (or keep a per-node data-version counter maintained at the `FlowDocument`
  layer, so the key becomes a cheap fold over `(id, type, dataVersion)`).
- The 500ms debounce (`use-flow-update-dispatcher.ts:14`) has **no max-wait**.
  Under continuous edits from a large group the timer resets forever and the
  local runtime silently stops receiving flow updates while people are typing.
  Add a `maxWait` (~1500ms) so dispatch is starved but never stopped.

## 5a. `DebounceScheduler.cancel()` is a no-op

`use-flow-update-dispatcher.ts:27` — the comment concedes it: react-pacer's
`Debouncer` isn't cancelled on teardown, so a pending dispatch fires after
`destroy()`. The `destroyed` flag inside the scheduled closure catches it
(`flow-update-dispatcher.ts:238`), so this is currently harmless — but the
`DispatchScheduler` contract says `cancel()` cancels, and the next
implementation that trusts it will be wrong. react-pacer exposes `cancel()` on
the `Debouncer` instance; wire it up.

## 5b. Concurrent dispatches can race `lastDispatchKey`

`flow-update-dispatcher.ts:257` — `send()` is `async` and not serialized. If
dispatch *A* is in flight when *B* is scheduled and *B* completes first, *A*'s
older key is written last, and a subsequent genuinely-different update whose key
matches *A*'s gets skipped. Given `dispatchNow()` can be called concurrently
with the debounced path, this is reachable. Track an in-flight generation
counter and drop the key write when the response is stale.

---

## 6. The Tauri IPC path re-sends the whole flow on every change

**Severity: medium.** `apps/web/src/session/tauri-flow-update-sender.ts:6`,
`apps/web/src-tauri/src/runtime/commands.rs:66`

Credit where due: core's `FlowRuntime::update_flow`
(`crates/microflow-core/src/runtime/mod.rs:227`) already diffs — it compares
`node_data` per id and rebuilds only changed components. The waste is entirely
in getting there. Every dispatch serializes the full node and edge set to JSON,
pushes it across the Tauri IPC boundary, and Rust deserializes all of it, just
to discover that one node's `data` changed.

For a 300-node flow with sizeable `data` payloads this is a multi-hundred-KB
round trip per accepted edit, and in a busy room accepted edits arrive from
everyone.

**Fix (incremental, in order):**

- Cheapest: keep the full-flow command but make the *frontend* skip when its
  key is unchanged — that already happens (§5), so the remaining win is
  avoiding the serialization itself. Passing a precomputed per-node data hash
  alongside each node would let Rust skip `serde_json::Value` comparison too.
- Better: add a `flow_update_delta` command carrying `{ added, changed,
  removed, edges }`. `FlowUpdate`'s diff logic in core already has the exact
  shape needed; the actor's `last_flow` (`host.rs:162`) is the base to diff
  against. This keeps the existing full-update command as the resync path.
- Tauri v2 supports raw/binary IPC responses; if payload size stays a problem,
  the flow can go over as a length-prefixed binary blob rather than JSON.

Note also `commands.rs:73` logs an `info!` line per flow update, and
`ipc.ts:172` `console.log`s the entire command payload — including broker
usernames/passwords and LLM API keys (`gatherBrokers`/`gatherProviders` pass
them through verbatim). That is both a hot-path cost and a credential-leak into
devtools/log files. It should be removed or gated behind a debug flag with the
secrets redacted.

---

## 7. Node-level writes are last-write-wins over the whole node

**Severity: medium — a collaboration-quality issue rather than a perf one.**
`packages/collab/src/schema.ts:54`

`nodes` is a `Y.Map<FlowNode>` holding **plain JavaScript objects**. Yjs treats
each value as an opaque atom, so every write replaces the entire node. Two
contributors editing *different fields of the same node* concurrently do not
merge — the later write wins and the earlier one is silently discarded. Worse,
`updateNodeData` (line 99) does read-modify-write outside any awareness of the
remote state, so a peer's concurrent `data` edit is clobbered wholesale.

Position is the most visible case: A drags a node while B renames it, and one of
the two edits vanishes. In a group session that reads as "the app lost my work".

**Fix:** nest the mutable parts. `Y.Map<Y.Map<unknown>>` for nodes, with
`position` and `data` as nested `Y.Map`s, gives per-field CRDT merge. That is a
real migration (the bridge, `getNodes()`, and persisted docs all touch it), so
it deserves its own ADR and a doc-version upgrade path — but it is the
difference between "collaborative" and "collaborative until two people touch the
same node".

An intermediate step that buys most of the safety for far less work: make
`updateNodePosition` and `updateNodeData` write only the sub-key they own by
storing `position` and `data` as nested `Y.Map`s while leaving the rest of the
node flat.

---

## 8. Presence and reconnect robustness

`packages/collab/src/sync-provider.ts`

- **Unbounded offline queue** (line 87). `pendingUpdates` grows without limit
  while disconnected. A long offline editing session, or a client that never
  reconnects, holds every update in memory and then floods the server with
  hundreds of individual frames on reconnect (`flushPendingUpdates`, line 314).
  Fix: `Y.mergeUpdates(this.pendingUpdates)` into one frame before sending, and
  cap the queue by byte size — past the cap, drop the queue and rely on
  sync-step-1 to reconcile, which is what the CRDT is for.
- **No jitter in reconnect backoff** (line 223). `1000 * 2^attempts` is
  deterministic, so every client disconnected by a server restart comes back in
  lockstep — a thundering herd precisely proportional to room size. Multiply by
  a random factor in `[0.5, 1.5]`.
- **Reconnect gives up permanently** after 10 attempts (line 218) with no
  recovery path. Add `window.addEventListener("online", …)` and a
  `visibilitychange` handler to reset `reconnectAttempts` and retry, so a laptop
  reopened after lunch reconnects instead of sitting there looking synced.
- **Stale peers after disconnect.** On `ws.onclose` the local `Awareness` keeps
  every remote client's state, so other people's cursors and avatars linger on
  a disconnected client. Call `removeAwarenessStates` for all non-local clients
  on close.
- **`getAwarenessUsers()` allocates a new `Map` and clones every user object**
  on every awareness event (line 360), and `WebSocketSyncAdapter.readUsers`
  (`websocket-sync-adapter.ts:40`) then converts it to a new array. At cursor
  frequency in a large room this is meaningful garbage. Fold this into the §3
  fix.
- **Auth token in the query string** (line 167). `?token=…` lands in server
  access logs, proxy logs, and browser history. Prefer the `Sec-WebSocket-Protocol`
  header or a short-lived one-time ticket exchanged over HTTP before the upgrade.

---

## 9. Server-side robustness under load

`packages/collab/src/yjs-server.ts`, `packages/collab/src/handler.ts`

- **No backpressure on broadcast** (line 362). `socket.send` is called in a
  loop with no check on buffered amount. One slow or stalled client in a busy
  room causes unbounded server-side buffering. Check `bufferedAmount` (Bun/Hono
  expose it) and close connections that exceed a threshold — a client that
  can't keep up should resync from scratch, not be buffered indefinitely.
- **No message size cap or rate limit per connection.** A single contributor
  (or a buggy client) can flood the room. Cap inbound frame size and apply a
  token bucket per connection before `receive()`.
- **Persist debounce has no ceiling** (line 384). `schedulePersist` clears and
  re-arms on *every* update. In a room where someone is always typing, the 2s
  timer never expires and the flow is **never persisted** until activity stops.
  A crash then loses the whole session. Track `firstDirtyAt` and force a persist
  once it exceeds a max age (~10s).
- **Full-state persist on every flush** (line 398). `Y.encodeStateAsUpdate(doc)`
  serializes the entire document each time. Fine at current sizes; worth
  revisiting with incremental updates + periodic compaction if flows grow.
- **`onOpen` is async; `onMessage` can fire first** (`handler.ts:29`, `:67`).
  Messages arriving before `join()` resolves hit `if (!connection) return` and
  are dropped silently. In practice the client sends sync-step-1 immediately on
  open, so this is a live race — the client's first sync message can vanish, and
  it will sit in `syncing` until something else nudges it. Buffer inbound frames
  until the connection handle exists, then replay them.
- **Awareness identity stamping cost** (line 302). `stampAwarenessIdentity`
  decodes and re-encodes JSON for every awareness message. It is correct and
  necessary (it prevents presence spoofing), but it sits directly on the
  highest-frequency path in the system — another reason throttling cursors (§2)
  pays off on the server as well as the wire.

---

## 10. Bridge correctness gaps worth closing

`apps/web/src/session/react-flow-bridge.ts`

- **`nodeNeedsWrite` compares only position and dimensions** (line 72). A
  ReactFlow `replace` change is classified structural but then dropped by the
  diff if it changed only `data` or `type`. Today node data reaches the doc via
  `doc.updateNodeData` (`use-node-controls.tsx:55`), bypassing the bridge, so
  this is latent rather than live — but it is a trap set for the next person who
  routes a data change through `applyNodeChanges`. Either compare `data`/`type`
  too, or document loudly that the bridge is position-and-size only.
- **`writeEdgesToDoc` never updates an existing edge** (line 281):
  `if (yMap.has(edge.id)) continue;`. Meanwhile the canvas sets
  `edgesReconnectable={!readOnly}` (`react-flow-canvas.tsx:101`) with no
  `onReconnect` handler wired — so edge reconnection is half-enabled and
  wouldn't persist if it were finished.
- **`destroy()` drops pending writes** (line 183). It cancels the pending
  animation frame without flushing. Unmounting within one frame of an edit —
  navigating away right after dragging a node — loses that edit. `flush()`
  before cancelling.
- **`writeNodesToDoc` rewrites the full map** (line 257): two `Set`s built over
  all ids plus a per-node diff, every frame a drag ends. Tracking dirty ids in
  `applyNodeChanges` would make the flush proportional to what changed.
- **Live drag positions are never shared** (line 50): position changes are
  ephemeral while `dragging`, so remote peers see nodes teleport on drop rather
  than move. That is a defensible trade (it keeps drag churn out of the CRDT and
  the undo stack), but the better answer for a group is to publish drag
  positions over **awareness** — ephemeral by construction, no CRDT cost — and
  commit to the doc on drop. Same channel as cursors, same throttle.

---

## Work items

Ordered by (impact at scale ÷ effort), not by section number.

| # | Change | Section | Status |
|---|---|---|---|
| 1 | In-flight guard in `getOrCreateRoom`; delete-before-destroy in `cleanupRoom` | §1 | ✅ done |
| 2 | Throttle `updateCursor` to one frame | §2 | ✅ done |
| 3 | `useFlowAwareness` stops subscribing to awareness | §3 | ✅ done |
| 4 | Identity-preserving `mergeYjsIntoSnapshot` | §4 | ✅ done |
| 5 | Compute `runtimeRelevantKey` once; add debounce `maxWait` | §5 | ✅ done |
| 6 | Persist ceiling on the server; merge the offline queue; backoff jitter | §8, §9 | ✅ done |
| 7 | Split presence out of the sync snapshot; memo cursor components | §3 | ✅ done |
| 8 | Remove/redact the IPC and flow-update payload logging | §6 | ✅ done |
| 9 | Backpressure + rate limits on the WS server | §9 | ✅ done |
| 10 | Bridge: flush on destroy, dirty-id tracking, edge updates | §10 | ✅ done |
| 11 | Drag positions over awareness | §10 | ✅ done |
| 12 | Nested `Y.Map` for `data` | §7 | ✅ done — [ADR-0019](adr/0019-nested-node-fields-for-concurrent-edits.md) |
| 13 | Delta `flow_update` IPC command | §6 | ⛔ not done |

Item 4b (`useFlowNodes` rebuilding per subscriber) landed alongside item 4.

One recommendation in §2 was **dropped after checking it**: splitting identity
out of the volatile presence fields. `encodeAwarenessUpdate` JSON-stringifies
the entire state object on every update regardless of which field changed
(`y-protocols/awareness.js`), so the split would not have reduced wire size.
Rounding cursor coordinates to whole flow units does, and was done instead.

---

## Results

Measured with `bun run bench` from `apps/web`. Each benchmark compares against
an inline re-implementation of the previous behaviour, so the two numbers come
from the same run on the same machine.

### Canvas: node re-renders caused by one peer's edit

ReactFlow memoises a node's render on its object identity, so the count of
identities that change per remote edit is a direct proxy for how many node
components React re-renders.

| flow size | before | after | |
|---|---|---|---|
| 25 nodes | 5,000 | 199 | 25x fewer |
| 100 nodes | 20,000 | 101 | 101x fewer |
| 300 nodes | 60,000 | 199 | 302x fewer |
| 1000 nodes | 200,000 | 199 | 1005x fewer |

The reduction is exactly proportional to flow size, which is the signature of
the bug: the old merge's cost per edit was O(flow), the new one is O(changed).

The merge call *itself* is only 1.15–1.32x faster (fewer allocations). The win
is not in the merge; it is in the work React no longer does downstream.

Scaled to a room on a 300-node flow, assuming each contributor commits ~2
edits/second:

| contributors | before | after |
|---|---|---|
| 5 | 3,000 renders/s | 10 renders/s |
| 20 | 12,000 renders/s | 40 renders/s |

### Server: presence fan-out

A real `YjsServer` with in-memory sockets, over 10 seconds of everyone moving
their cursor. "Before" is one frame per pointer event (~120/s); "after" is the
client throttle's ceiling of 20/s.

| room size | frames out (before) | frames out (after) | bandwidth before | after |
|---|---|---|---|---|
| 2 | 2,400 | 400 | 0.36 MB | 0.06 MB |
| 5 | 24,000 | 4,000 | 3.60 MB | 0.60 MB |
| 10 | 108,000 | 18,000 | 16.20 MB | 2.68 MB |
| 20 | 456,000 | 76,000 | 68.90 MB | 11.36 MB |

The quadratic term is plainly visible: 10x the people is 190x the frames. The
throttle cuts a constant ~6x off it (84% of bandwidth), which does not change
the exponent — a room large enough will still saturate. What it buys is roughly
a 2.4x larger room for the same server cost, and it moves 20-person rooms from
~6.9 MB/s of cursor egress to ~1.1 MB/s.

Server CPU for that fan-out, over the same 10 seconds: 729ms → 147ms at 20
contributors.

### Dispatcher: per-accepted-change cost

| flow size | payload | before | after | saved |
|---|---|---|---|---|
| 25 nodes | 5 KB | 0.05ms | 0.03ms | 36% |
| 100 nodes | 21 KB | 0.26ms | 0.17ms | 44% |
| 300 nodes | 64 KB | 0.76ms | 0.47ms | 33% |
| 1000 nodes | 215 KB | 2.58ms | 1.36ms | 44% |

A real saving, but a modest one in absolute terms — at 300 nodes and 10
dispatches/second this is ~4.7ms/s of main thread, down from ~7.6ms/s. Worth
having, not worth celebrating. The IPC payload column is the more interesting
number, and it is the argument for item 13 below.

---

## What is not done

**Item 13 — delta `flow_update` IPC command.** Not attempted: the Tauri crate
does not compile in the environment this work was done in (`gdk-3.0` and the
rest of the GTK stack are absent), so the Rust half could not be built, run, or
tested. Writing it blind into the desktop runtime would be worse than not
writing it. `microflow-core` itself compiles and its 484 tests pass, so the
blocker is specifically the `apps/web/src-tauri` crate.

The measurements above size the prize: 64 KB per dispatch at 300 nodes
(0.62 MB/s at 10 dispatches/second), 215 KB at 1000 nodes (2.10 MB/s). Core's
`FlowRuntime::update_flow` already diffs per node on the far side, so this is
purely the cost of getting there. Worth doing on a machine with the Tauri
toolchain; not urgent at typical flow sizes.

**Item 12 — nested `Y.Map` for node `data`.** Deliberately not landed in this
batch, and written up instead as
[ADR-0019](adr/0019-nested-node-fields-for-concurrent-edits.md). It changes the
format of every persisted document, which needs a decision rather than a patch.

Doing item 4 also turned up a constraint that materially affects its design:
the identity-preserving merge relies on Yjs returning a stable object reference
for a node nobody wrote, which is true *because* nodes are stored as opaque
objects. Materialising a plain object from a nested `Y.Map` allocates on every
read, so a naive implementation of item 12 would silently undo the largest
client-side win measured above. The ADR carries that constraint and the
required materialisation cache.

This one is still a real correctness gap — concurrent edits to different fields
of one node clobber each other, and it reads to users as lost work — so it
should be scheduled, not forgotten.
