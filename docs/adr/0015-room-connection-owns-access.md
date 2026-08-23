# ADR-0015 — The room connection handle owns the access decision

- **Status:** accepted (2026-08-23)
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
process. A second server instance would hold its own rooms — the same
constraint that already makes `flow.ydoc` last-writer-wins across instances.
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
