# ADR-0022 — The flow-role transition has one owner

- **Status:** accepted (2026-08-31)
- **Date:** 2026-08-31
- **Deciders:** sander

> **Decision:** `setFlowRole(flowId, userId, role | null)` in
> `packages/api/src/routers/flow-access.ts` owns a role transition end to
> end: the collaborator-row write, the `FlowRole → Access` mapping
> (`roleToAccess`), and the live push onto the user's sockets. Every role
> mutation routes through it.

## Context

A role change on a cloud flow is two writes: the `flowCollaborator` row
(what the *next* connection resolves) and `YjsServer.setAccess` (what live
sockets do *right now*). [ADR-0015](0015-room-connection-owns-access.md) put
the live half behind `setAccess`; the api side kept the two paired by
convention — each collaborator procedure wrote the row and then called the
push itself.

Convention is where the pairing broke. `inviteByEmail`'s grant path wrote
the row without the push, so a collaborator whose role changed through an
invite kept their old access until they reconnected — the stale-snapshot
problem ADR-0015 existed to close, reintroduced one caller later. The
structural cause: the row write lived in `@microflow/db` (Flow Invitation,
[ADR-0016](0016-flow-invitation-module.md)), which cannot reach the collab
server, while the push lived in `@microflow/api`. No module saw both
halves, so nothing could own the invariant.

## Decision

One function owns the transition. `setFlowRole` writes the row (`null`
revokes; a grant goes through ADR-0016's idempotent `grantAccess` upsert),
maps the role onto the room's own vocabulary (`roleToAccess`: viewer →
read, editor → write, null → none), and pushes it onto every live
connection the user holds. The former `flow-role.ts` folds into
`flow-access.ts`, so the role type, the resolution helpers, the enforcement
seam and the transition live in one module.

Callers that cannot reach it get it injected, or stay deliberately partial:

- **Flow Invitation** takes a `GrantRole` adapter, mirroring its
  `InviteMailer`: the api layer passes `setFlowRole`, so a grant made from
  db still reaches live sockets.
- **The sign-up accept path** (`acceptInvites`, in the better-auth
  `user.create.after` hook) calls `grantAccess` directly — rows only, by
  design. A user who just created their account holds no live socket to
  push to, and auth cannot reach collab.

## Consequences

- A role mutation cannot forget the live push; the invite-grant gap is
  closed and regression-tested.
- The same-process constraint of ADR-0015 is unchanged: `setFlowRole`
  reaches the `yjsServer` singleton, so api and the websocket endpoint must
  stay mounted together.
- `updateCollaboratorRole` keeps its existence check, so an update cannot
  silently become a create through the upsert.
- The sign-up path is a second grant caller by design. If an accepting user
  can ever hold a live socket at accept time, that path should take the
  `GrantRole` adapter too.
