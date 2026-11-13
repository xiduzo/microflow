# ADR-0015 — The room connection handle owns the access decision

- **Status:** accepted (2026-08-23); amended (2026-11-13)
- **Date:** 2026-08-23
- **Deciders:** sander

> **Decision:** `YjsServer.join()` returns a **Room Connection** handle, and
> that handle is the only way to reach a room. Access lives on it and stays
> live: `setAccess(flowId, userId, access)` reaches every socket a user holds,
> and the room stamps the authenticated user id onto inbound awareness state.

## Context

`YjsServer` exposed three entry points keyed on a `Connection` object the
caller supplied: `handleConnection(flowId, connection, userId, canWrite)`
registered it, `handleMessage(flowId, connection, data)` looked it up, and the
cleanup closure returned by the first removed it.

Nothing in that interface said "pass me the *same object* you registered", and
the only caller did not. `handler.ts` built a fresh `{ send, close }` literal
inside every `onMessage`, so the lookup always missed. While the room only used
the lookup for awareness bookkeeping this cost ghost cursors and a self-echo on
every update. Once [c0a56be](https://github.com/xiduzo/microflow/pull/95) put
the write bit behind that same lookup, a miss read as "no write access" and
**every** document write was dropped, for owners too.

The access tests written alongside that change all passed: they called
`YjsServer` directly with a stable object — a shape production never uses. The
seam was in the wrong place, so the tests bought no locality.

Two further gaps sat behind the same interface:

- **The role was a snapshot.** The endpoint resolved a Flow Role once, at
  connect. Removing a collaborator or demoting them to Viewer left their socket
  writable until they reconnected.
- **Presence was client-asserted.** `SyncProvider` sends whatever `user` object
  the client supplies and the room applied it verbatim, though it already knew
  the authenticated `userId` on the connection. A Viewer could appear as the
  Owner in cursors and the collaborator panel.

## Decision

`join()` returns a `RoomConnection`: `{ flowId, userId, canWrite, receive,
close }`. There is no room-addressed message entry point any more, so a
transport cannot present an unregistered connection — the misuse is a type
error rather than a silent downgrade to stranger.

The handle owns what used to be smeared across the caller and a lookup: the
socket, the write bit, and the awareness client ids to clear on close.

Access is expressed in the room's own vocabulary, `"none" | "read" | "write"`,
not as a `FlowRole`. The collab package knows about reading and writing; who
counts as an owner is the api package's business, and `syncLiveAccess` in the
flow router maps between them. `setAccess` applies to every connection the
named user holds; `"none"` closes their sockets.

Inbound awareness updates are decoded and re-encoded with `user.id` overwritten
from the connection, in the same pass that already tracked client ids.

**Same-process only.** `setAccess` reaches the `yjsServer` singleton, which
works because `apps/server` mounts the tRPC router and `/yjs/:flowId` in one
process. A second server instance would hold its own rooms: their saves merge
in the store (see the amendment below), but two instances do not see each
other's edits live, and `setAccess` reaches only the rooms in its own process.
Scaling out means a shared room registry, and this decision does not stand in
the way of one: `setAccess` is the interface a distributed implementation would
satisfy.

## Consequences

- Cloud writes work again.
- Revocation and demotion take effect on live sockets, not at next reconnect.
- Presence identity is server-stated.
- `handler.ts` holds the handle on `ws.raw` for the life of the socket; a
  message arriving before `onOpen` resolves is dropped rather than
  misattributed.
- Tests cross the seam the transport crosses: `yjs-handler.test.ts` drives
  `createYjsHandler()` end to end and fails against the old shape, while
  `yjs-server-access.test.ts` exercises the room through handles.

---

## Amendment (2026-11-13): room durability

A room is **settled** when every change its document has accepted is in the
`RoomStore` and no save is in flight. `RoomPersistence`
(`packages/collab/src/room-persistence.ts`) owns that, one per room, behind
`isSettled`, `flush()` and `stop()`:

- **Dirty tracking comes from the document's `update` event**, never from the
  sync message type. A reconnecting client delivers its offline edits as sync
  step 2, not as an update frame, so the message type is not a proxy for "the
  document changed".
- **Debounce with a ceiling** (2 s quiet, at most 10 s unsaved), so a room where
  somebody is always typing is still written.
- **Retry with backoff that does not give up** (1 s doubling to 30 s) while the
  room is in memory. Time comes through a `PersistClock` seam, so tests assert
  exact delays.

A room is destroyed only when settled. A room whose save keeps failing stays in
memory and is handed back to the next join with its unsaved edits, rather than
that join loading an older document from the store. The room acknowledges a save
(`MESSAGE_ACK`) only when settled; a client joining a room with a save due or in
flight, and every client in a room whose save failed, gets `MESSAGE_UNSAVED`
instead, so no client shows "Saved" for an edit that is not stored.

**Saves merge.** `RoomStore.save` merges the incoming state into the stored one
(`mergeDocumentStates`); `drizzleRoomStore` does it in a transaction under a row
lock. Overlapping deploys can leave the old instance's final save landing after
the new instance accepted edits; a replace would erase them, a merge cannot.
Rooms on different instances therefore converge in the store, though they still
do not see each other live.

**Readers take the live room first.** `flow.get`, `flow.list` and
`flow.publish` read `YjsServer.currentState(flowId)` ahead of `flow.ydoc`, which
lags a live room by up to the save ceiling. A room awaiting a successful save is
still loaded, so its edits are visible there too.

**Shutdown drains.** On SIGTERM, `installShutdownHook` (`apps/server/src/shutdown.ts`)
calls `YjsServer.shutdown(8_000)`: new joins are refused, every socket is closed
with 1012 (the client reconnects to the next instance and re-sends what the store
lacks), and rooms are saved until all are settled or the time runs out. The
process exits non-zero if any room is unsaved. The orchestrator's stop grace
period must be longer than the drain.

**A deleted flow stays deleted.** `dropRoom` records the flow id; a join racing
`flow.delete` is closed with 4404, and a late rename write is ignored.

## Amendment (2026-11-13): the client is told, and close codes say what to do

**Live access is stated, not inferred.** The room sends each connection a
`MESSAGE_ACCESS` frame (`none` / `read` / `write`) on join and whenever
`setAccess` changes it. The client's role from `flow.get` is a page-load
snapshot; the frame overrides it for the rest of the session, so a demoted
Editor's canvas stops accepting edits the room would drop, and a promoted
Viewer can edit without a reload.

**Close codes are classified by the client's next move** (`classifyClose` in
`packages/collab/src/protocol.ts`):

| Code | Sent when | Client |
|---|---|---|
| 4401 | access revoked (`setAccess(…, "none")`), or no access decision reached the room | stop (terminal) |
| 4403 | the gate denied this user | stop (terminal) |
| 4404 | the flow does not exist or was deleted | stop (terminal) |
| 1008 | no valid session | refresh the token, at most 3 attempts |
| 1011 | the gate or the room could not decide or load (database, store) | retry |
| 1012 | the server is restarting | retry |
| 1013, others | too many frames before join, a dropped room, the network | retry |

The websocket gate (`apps/server/src/room-gate.ts`) separates a **decision**
from a **failure to decide**: a denial is terminal, but a database timeout while
checking is 1011 and retried, so a deploy hiccup does not lock every client
out. Every 4400–4499 code is terminal, so a new terminal reason needs no client
change.

**The server owns `meta.name` in the document.** The flow row owns the name;
`flow.update` mirrors a rename into the document through
`YjsServer.writeMeta`, the same pattern [ADR-0022](0022-flow-role-transition-has-one-owner.md)
uses for roles. With a live room the write goes into it and is broadcast; with
none it is merged into the store. The mirror is best-effort with background
retries, because the row has already committed. Clients do not write
`meta.name` when they open a flow.
