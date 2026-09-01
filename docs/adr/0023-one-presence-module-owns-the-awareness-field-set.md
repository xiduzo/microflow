# ADR-0023 — One presence module owns the awareness field set

- **Status:** accepted (2026-08-31)
- **Date:** 2026-08-31
- **Deciders:** sander
- **Amends:** [ADR-0003](0003-flow-session-seam.md) (the adapter roster:
  `WebSocketSyncAdapter` is deleted; the seam itself stands)

> **Decision:** `SyncProvider` satisfies `RemoteSyncAdapter` directly, and
> `apps/web/src/session/presence.ts` owns the presence read path: slices
> with their equality, one declaration per presence field. Consumers
> subscribe to the slice they draw.

## Context

[ADR-0020](0020-lean-on-the-yjs-ecosystem.md) thinned `SyncProvider` to a
wrapper over `y-websocket` owning presence throttling, the local user
record and the cached awareness view. The session layer then wrapped it
again: `WebSocketSyncAdapter` was 105 lines of pass-through — forwarding
calls, renaming events — between two shapes that had converged.

The pass-through cost more than its line count. Adding one presence field
(live drag positions, say) meant touching the provider, the adapter type,
the pass-through, `RecordingSyncAdapter`, and each consuming hook. And the
read side had three subscription strategies: every consumer took the whole
`users` array and hand-rolled — or forgot — its own equality, so cursors
redrew on selection-only changes and the collaborator panel re-rendered at
pointer rate.

## Decision

Delete the pass-through. `SyncProvider` takes the adapter's event names and
the few members it lacked (`kind`, `isSynced`, `error`, `reconnect`, an
identity-stable `users` getter) and satisfies `RemoteSyncAdapter`
structurally — the type annotation in `createCloudSession` is the
compile-time proof. `RecordingSyncAdapter` remains the second adapter that
keeps the seam real.

Presence reads become slices. A `PresenceSlice<T>` is `{ select, equal }`;
`presence.ts` declares `cursorsSlice`, `collaboratorsSlice` and
`remoteDragSlice`, and `observePresence` / `usePresence` wake a consumer
only when its slice moves. The equality lives beside the field set, once,
instead of per consumer.

## Consequences

- A presence field costs one slice declaration plus the provider's write
  path — nothing in between to keep in step.
- Render granularity is per slice: cursors no longer redraw on selection-
  or drag-only changes, and the collaborator panel stops re-rendering at
  pointer rate. The render/dispatch budgets hold.
- `useFlowSync` keeps only the connection-state surface; presence is no
  longer read through it.
- No slice reads remote *selection* yet, because nothing renders it; the
  first consumer declares that slice.
