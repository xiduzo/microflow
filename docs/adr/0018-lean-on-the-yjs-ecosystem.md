# ADR-0018 — Lean on the Yjs ecosystem; justify what stays custom

- **Status:** accepted
- **Date:** 2026-08-28
- **Deciders:** sander

## Context

The collaboration scaling audit ([`COLLAB_SCALING_AUDIT.md`](../COLLAB_SCALING_AUDIT.md))
fixed eleven problems in the Yjs ↔ ReactFlow ↔ Tauri path. Reviewing the result
raised a sharper question than any individual fix: **how much of that was work
the Yjs ecosystem already does for us?**

The answer was uncomfortable. The package.json listed only `yjs` and
`y-protocols`. `SyncProvider` (409 lines) and `YjsServer` (518 lines) were
hand-rolled reimplementations of a WebSocket provider and room server. Several
of the audit's headline bugs were *reimplementation* bugs — they could not have
occurred in the library:

- The concurrent-join race that silently orphaned a client existed because
  `getOrCreateRoom` was written from scratch and made async.
- The offline update queue, its byte cap and its `Y.mergeUpdates` collapse were
  ~40 lines solving a problem that should not exist: `y-websocket` does not
  queue at all, it resyncs from sync-step-1, which is the point of a CRDT.
- `clearRemotePresence` duplicated something `y-protocols/awareness` already
  does on a 3-second interval via `outdatedTimeout`.

Writing a CRDT transport by hand is not a neutral choice. It is a standing
commitment to re-derive, and re-debug, behaviour that a maintained library has
already got right.

## Decision

**Default to the ecosystem. Custom code in the collaboration layer must earn
its place, and the justification belongs in this file.**

Concretely, for the transport:

- **The client transport is `y-websocket`'s `WebsocketProvider`.** `SyncProvider`
  becomes a thin wrapper owning only presence throttling, the local user
  record, the cached awareness view, and our `ack` message.
- **The server stays custom**, for reasons recorded in the inventory below.
  This is a deliberate exception, not an oversight.

We evaluated and rejected two alternatives:

- **Hocuspocus (server + provider).** The closest fit by far — its
  `onAuthenticate` / `onLoadDocument` / `onStoreDocument` hooks map onto our
  access model and `RoomStore`, its `debounce` + `maxDebounce` *is* the persist
  ceiling we hand-wrote, `beforeHandleAwareness` replaces
  `stampAwarenessIdentity`, and it queues pre-auth messages the way our handler
  now does. A spike confirmed it runs under Bun and enforces all five of our
  critical properties. Rejected on rollout cost: its wire protocol differs, so
  server and every client must deploy together, and desktop users on an older
  build would lose collaboration until they update. Worth revisiting.
- **`@y/websocket-server`.** The extracted reference server. Rejected on fit:
  global singleton `docs` map and `setPersistence`, `setupWSConnection` typed
  against Node's `ws` and `http` rather than our Hono/Bun transport, and no
  access-control model at all.

### The standing rule

Before writing anything new in `packages/collab`, check whether the ecosystem
covers it, and if you write it anyway, add a row to the inventory saying why.
Where a library *nearly* fits, prefer bending our code to its shape over
reimplementing it.

## Inventory

Every custom component in the collaboration path, and why it exists.

| Component | Community option | Verdict |
|---|---|---|
| `sync-provider.ts` transport | `y-websocket` | **Replaced.** 692 → 452 lines. |
| `sync-provider.ts` presence throttle | — | **Keep.** `y-websocket` broadcasts awareness on every local change and has no notion of a presence budget. At pointer rate in a room this is the dominant wire cost; the benchmarks put it at 84% of cursor bandwidth. |
| `sync-provider.ts` local user + awareness cache | — | **Keep.** App-shaped view; the cache exists because the React layer reads it at cursor rate. |
| `yjs-server.ts` | Hocuspocus, `@y/websocket-server` | **Keep, with reservations.** See the rejected alternatives above. Its distinguishing features — per-connection read/write ([ADR-0015](0015-room-connection-owns-access.md)), mid-session revocation, awareness identity stamping, send backpressure, per-connection rate limits — are absent from `@y/websocket-server` and present in Hocuspocus. If the flag-day deploy ever becomes acceptable, this row is the one to revisit. |
| `handler.ts` | — | **Keep.** Hono/Bun transport glue; no community adapter exists for this pairing. |
| `room-store.ts`, `drizzle-room-store.ts` | `y-leveldb`, `y-redis` | **Keep.** We persist to Postgres through Drizzle alongside the rest of the app's data. The seam itself is the right shape — it is what a Hocuspocus `onStoreDocument` would call. |
| `protocol.ts` | — | **Keep.** The shared numbering *is* the contract, and it is constrained by y-websocket's reserved range. Documenting it is the whole point. |
| `schema.ts` (`FlowDocument`) | `syncedstore`, `valtio-yjs`, `zustand-middleware-yjs` | **Keep the seam, fix the shape.** Those libraries impose a state-management paradigm on a codebase that already has one. The real problem is not the wrapper, it is that nodes are stored as plain objects so Yjs cannot merge them — see [ADR-0017](0017-nested-node-fields-for-concurrent-edits.md). Adopting a library here would not fix that; nesting the fields would. |
| `react-flow-bridge.ts` | a ReactFlow↔Yjs binding, if one exists | **Keep.** No maintained binding is known to us. *Not verified* — registry lookups were unavailable in the environment where this was written, so this row is based on absence of knowledge, not evidence of absence. Worth ten minutes with a working npm search before anyone extends this file substantially. |
| `flow-update-dispatcher.ts`, senders | — | **Keep.** The Tauri/wasm runtime seam; nothing to do with Yjs. |
| `use-flow-sync.ts`, `use-remote-drag.ts`, hooks | — | **Keep.** App-specific React glue over the adapters. |
| `local-storage-sync-adapter.ts` | **`y-indexeddb`** | **Replaced.** Deleted; see below. |
| `recording-sync-adapter.ts` | — | **Keep.** Test double. |

### `local-storage-sync-adapter.ts` — deleted

It subscribes to `onAnyChange` and, on **every** document change, serialises the
entire flow to JSON and writes it to `localStorage`:

```ts
this.unobserve = doc.onAnyChange(() => {
  saveStored({ nodes: doc.getNodes(), edges: doc.getEdges() });
});
```

Unthrottled, whole-document, synchronous, on the main thread — the same class
of problem as the dispatcher's double serialisation that the audit measured at
0.76ms per dispatch on a 300-node flow, except this one runs on every keystroke
rather than every 500ms, and `localStorage` is synchronous I/O.

`y-indexeddb`'s `IndexeddbPersistence` replaced it wholesale: incremental
persistence of the Y.Doc, no JSON round trip, and the document's history
survives a reload instead of being flattened into a node/edge snapshot.

Migration is additive. The legacy payload is imported only when IndexedDB comes
back empty — a stale snapshot must never clobber newer stored work — and the
old key is deliberately left in place, because it is the only copy of a local
user's flow and leaving it means a rollback still finds it.

The same package would also give **cloud** flows offline durability across a
reload, which we do not have today at all. That is a larger change (it
interacts with the server's authority over the document) and is not done.

## Consequences

**Gained, beyond deleted code.** `y-websocket` brings behaviour we did not
have: a "no message in 30 seconds" watchdog that reconnects a silently-dead
socket, cross-tab `BroadcastChannel` relay so two tabs on one flow sync
directly, and a terminal-close convention (codes 4400–4499) we now use so a
revoked collaborator stops reconnecting.

**A constraint we did not have before.** Message numbering is no longer ours.
`MESSAGE_ACK` was 2, which collides with y-websocket's `messageAuth`; the
provider would have handed our persistence acknowledgement to `readAuthMessage`.
It is now 4, and `protocol.ts` exists so the next person adding a message type
sees the constraint before they trip on it.

**Tests were deleted, not ported.** The cases covering our reconnect, backoff
and offline queue tested an implementation that no longer exists. Keeping them
would have meant testing `y-websocket`, which is not our job.

**We are now exposed to upstream.** A `y-websocket` regression is our
regression, and its release cadence is not ours. This is the trade we are
making deliberately: a maintained dependency with many users finds bugs faster
than a private reimplementation with one.
