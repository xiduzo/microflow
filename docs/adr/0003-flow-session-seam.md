# ADR-0003 — `FlowSession` seam, with per-mode `SyncAdapter` and grace-period `SessionRegistry`

- **Status:** accepted
- **Date:** 2026-05-22
- **Deciders:** sander

## Context

The web app's editing / collaboration layer is smeared across one zustand
store and four hooks:

- `apps/web/src/stores/flow-store.ts` (552 LOC) — owns the live
  [`FlowDocument`](../../packages/collab/src/schema.ts), `mode` (`"local"` |
  `"cloud"`), clipboard, `localStorage` persistence, plus calls
  `invokeCommand` into the Rust runtime via `setupDocSync` (a second
  concern: pushing `FlowUpdate`s to the native runtime).
- `apps/web/src/hooks/use-sync-provider.ts` (213 LOC) — owns a
  `providerRef`, constructs a [`SyncProvider`](../../packages/collab/src/sync-provider.ts)
  from `flowDoc + flowId + user + wsUrl + authToken`, manages cleanup on
  flow switch.
- `apps/web/src/hooks/use-flow-document.ts` (342 LOC) —
  `useFlowState`, `useFlowNodes`, `useFlowEdges`, `useFlowMeta`,
  `useFlowHistory`, `useFlowData`. Owns the Yjs↔React reconciler
  (`isSyncingFromYjs`, `pendingYjsSync`, `requestAnimationFrame`).
- `apps/web/src/hooks/use-collab-flow.ts` (132 LOC) — orchestrator
  combining store-init + `useSyncProvider` + `useFlow*` hooks.
- `apps/web/src/stores/sync-state-store.ts` (91 LOC) — separate zustand
  store mirroring sync state per-`flowId`, written by `useSyncProvider`,
  read by routes. Exists only because no single object owns "sync state
  for this flow."

The smearing produced concrete friction:

- **Two adapters already exist, unnamed.** `routes/flow/$flowId.tsx`
  contains `LocalFlowLayout` + `CloudFlowLayout` and an inline
  `localFlowSync` constant explicitly marked
  `// No-op sync provider for local flows`. That is a no-op adapter of
  the sync seam, sitting in the route file because the seam has no name.
- **Sync state has no owner.** `useSyncStateStore` is a third party
  carrying state between the hook that writes it and the routes that
  read it.
- **Lifecycle is implicit.** `useFlowStore.getState().initLocalFlow()`
  and `initCloudFlow(flowId, initialData)` can be called from anywhere;
  destroy is whoever remembers. Strict Mode double-mount, fast
  back-button, and route hot-swap each have their own ad-hoc
  reconciliation.
- **The store has two jobs.** Live editing context + native runtime
  bridge live in one file. The runtime bridge imports `NODE_REGISTRY`,
  `useMqttBrokerStore`, `useFigmaStore`, and `invokeCommand`. Editing
  doesn't need any of that.
- **Tests need the React renderer to exercise anything.** Verifying
  "two collaborators converge on the same nodes" requires
  `@testing-library/react`, a real `SyncProvider`, and a Yjs WebSocket
  server. The thing being tested — convergence — is a property of the
  sync layer, not React.

The `LocalFlowLayout` / `CloudFlowLayout` split, the no-op-marked
`localFlowSync` constant, and the per-`flowId` `useSyncStateStore` are
all symptoms of the same missing concept: a **`FlowSession`** —
the live editing context wrapping a `FlowDocument` and a pluggable
sync seam.

## Decision

Introduce a `FlowSession` module under `apps/web/src/session/`, owning
the editing context and exposing a typed sync seam. Replace the
store-+-four-hooks layout.

```
┌─ Layer 1: SyncAdapter (the seam) ─────────────────────────┐
│  interface SyncAdapter {                                   │
│      destroy(): void;                                      │
│  }                                                         │
│  interface RemoteSyncAdapter extends SyncAdapter {         │
│      readonly state: SyncState;                            │
│      readonly isSynced: boolean;                           │
│      readonly users: AwarenessUser[];                      │
│      readonly error: Error | null;                         │
│      updateCursor(p): void;                                │
│      updateSelectedNodes(ids: string[]): void;             │
│      reconnect(): void; disconnect(): void;                │
│      on(event, cb): () => void;                            │
│  }                                                         │
└────────────────────────────────────────────────────────────┘
┌─ Layer 2: Concrete adapters (three) ──────────────────────┐
│  LocalStorageSyncAdapter   implements SyncAdapter          │
│  WebSocketSyncAdapter      implements RemoteSyncAdapter    │
│  RecordingSyncAdapter      implements RemoteSyncAdapter    │
└────────────────────────────────────────────────────────────┘
┌─ Layer 3: FlowSession (plain object) ─────────────────────┐
│  type FlowSession = {                                      │
│      readonly flowId: string;                              │
│      readonly mode: "local" | "cloud";                     │
│      readonly doc: FlowDocument;                           │
│      readonly sync: SyncAdapter;                           │
│      destroy(): void;  // tears down sync, then doc        │
│  };                                                        │
└────────────────────────────────────────────────────────────┘
┌─ Layer 4: SessionRegistry (singleton, refcounted) ────────┐
│  Map<flowId, { session, refs, pendingDestroy }>            │
│  acquireLocalSession() / acquireCloudSession(opts)         │
│  releaseSession(flowId) — schedules destroy after 100ms    │
│  Survives React 18 Strict Mode double-mount and fast       │
│  back-button. No reuse across mode change.                 │
└────────────────────────────────────────────────────────────┘
┌─ Layer 5: React seam (Context, not zustand) ──────────────┐
│  <FlowSessionProvider session={...}>                       │
│  useFlowSession()  // throws if no provider                │
│  Context holds the session reference (rare changes).       │
│  Reactive data inside read via Y.Doc observers and         │
│  adapter event subscriptions — bypass Context for          │
│  high-frequency updates.                                   │
└────────────────────────────────────────────────────────────┘
```

Six sub-decisions:

- **D1 — Composition over inheritance.** `FlowSession` is a plain object
  with a polymorphic `sync: SyncAdapter` field. Three concrete adapters
  (`LocalStorageSyncAdapter`, `WebSocketSyncAdapter`,
  `RecordingSyncAdapter`) implement the seam. `RecordingSyncAdapter`
  can pair with any session, mirroring the
  [`BoardHandle` + `TestIoLoop`](../../apps/web/src-tauri/src/runtime/board/test_io_loop.rs)
  pattern from [ADR-0002](0002-per-capability-service-traits.md).
  Inheritance can't do that.

- **D2 — Type-honest split of local vs remote sync.** Today's local "sync"
  is faked as `{ state: "synced", isConnected: false }` — synced to what?
  Split the interface: base `SyncAdapter` carries only `destroy()`;
  `RemoteSyncAdapter extends SyncAdapter` adds `state`, `isSynced`,
  `users`, `error`, awareness write methods. `LocalStorageSyncAdapter`
  satisfies the base only. UI gates the sync chip / collaborator panel
  on the `RemoteSyncAdapter` discriminator, no lie in the state.

- **D3 — React Context for the session reference; Y.Doc observers for
  reactive data.** Hook-only API (no class instance held by callers).
  Backed by Context, not a zustand singleton: ownership is the provider
  component, mount/unmount drives lifecycle, `useFlowSession()` is
  type-narrowed inside the subtree (never null). Context value is the
  session reference — rare changes. High-frequency updates (nodes,
  edges, sync state) read via existing Y.Doc observer pattern and
  adapter `.on(event, cb)` subscriptions, bypassing Context.
  `useFlowSession()` throws if called outside the provider — surface
  bugs early.

- **D4 — `SessionRegistry` with 100ms grace-period destroy.** Module-level
  `Map<flowId, { session, refs, pendingDestroy }>`.
  `acquireSession` increments refs and cancels any pending destroy;
  `releaseSession` decrements and schedules destroy via
  `setTimeout(destroy, 100)` if refs hits zero. Strict Mode's
  mount→unmount→mount cycle lands within the 100ms window → second
  mount reuses the same instance. Fast browser back-button gets the
  same benefit. WebSocket churn (server logs, awareness join/leave
  broadcast to other collaborators) is avoided in dev. Pattern mirrors
  TanStack Query `gcTime`. Hot-swap between modes (`/flow/abc` →
  `/flow/local`) fully tears down — registry keyed on `flowId`, no
  cross-mode reuse.

- **D5 — Two adapters per remote shape from day one.**
  `WebSocketSyncAdapter` is the production path (wraps the existing
  `SyncProvider` from `@microflow/collab`).
  `RecordingSyncAdapter` records `appliedUpdates`, `awarenessUpdates`,
  `connectCalls`, `disconnectCalls`; scripts `injectRemoteUpdate`,
  `injectAwareness`, `injectState`, `injectError`. Mirrors
  [ADR-0002 D5](0002-per-capability-service-traits.md) and the
  `RecordingLlmProvider` / `RecordingMqttPublisher` discipline.
  The second adapter is what makes `RemoteSyncAdapter` a *real* seam,
  per [`LANGUAGE.md`](../../.claude/skills/improve-codebase-architecture/LANGUAGE.md).

- **D6 — Clipboard lifts to a sibling singleton; `FlowUpdateDispatcher`
  defers to a follow-up ADR.** The current store mixes editing,
  clipboard, persistence, and native-runtime push. This ADR scopes the
  editing+sync extraction. Clipboard moves to
  `apps/web/src/stores/clipboard-store.ts` as a separate zustand
  singleton that survives session swap (so users can copy-paste between
  flows). The native-runtime push (`setupDocSync` + broker/provider
  gathering) moves to a temporary
  `apps/web/src/session/use-flow-update-dispatcher.ts` hook, mounted
  only by the desktop layout (`isDesktop`-gated at the route — not
  inside the session). A follow-up ADR will deepen
  `FlowUpdateDispatcher` into its own module, name the dispatch
  protocol, and decide where broker/provider gathering belongs.

Roll out in four phases inside one PR (per `CLAUDE.md`: no
backwards-compatibility shims):

1. **Phase 1** — Add `session/` module: `sync-adapter.ts` (interfaces),
   `local-storage-sync-adapter.ts`, `websocket-sync-adapter.ts`,
   `recording-sync-adapter.ts`, `flow-session.ts` (factories),
   `session-registry.ts`. Vitest unit tests against the recording
   adapter from day one.
2. **Phase 2** — Add React surface: `flow-session-context.tsx`,
   `use-flow-session.ts`, `use-flow-sync.ts`, `use-local-session.ts`,
   `use-cloud-session.ts`, `use-react-flow-bridge.ts` (moves logic
   from current `useFlowState` — no deepening, that is candidate 2),
   `use-flow-history.ts`, `use-flow-meta.ts`,
   `use-flow-update-dispatcher.ts`.
3. **Phase 3** — Migrate call sites: 15 files now reading
   `useFlowStore` / `useFlowDocument` / `useCollabFlow` / `useLocalFlow`
   / `useSyncProvider`. Re-point to `useFlowSession()`,
   `useFlowSync()`, `useClipboardStore()`, `useReactFlowBridge(session)`,
   `useFlowHistory(session.doc)`.
4. **Phase 4** — Delete: `hooks/use-collab-flow.ts`,
   `hooks/use-sync-provider.ts`, `hooks/use-flow-document.ts`,
   `stores/sync-state-store.ts`. Reshape `stores/flow-store.ts` into
   `stores/clipboard-store.ts`. Routes wire
   `<FlowSessionProvider>` per layout.

Each phase compiles. Final phase is the rip.

## Consequences

**Positive**

- **Editing is testable without React or a WebSocket server.** Two
  `RecordingSyncAdapter`s in the same vitest file replay updates between
  one another; assert convergence on the underlying `FlowDocument`.
  Strict Mode bugs, awareness round-trip, disconnect/reconnect, clipboard
  paste across sessions — all unit-testable.
- **Type narrows inside the provider subtree.** No more
  `flowDoc?.addNode(...)` chains at call sites. `useFlowSession()`
  returns `FlowSession`, not `FlowSession | null`. Throws outside the
  provider — bug surfaces immediately, not as a silent no-op.
- **No more `useSyncStateStore`.** Sync state read via
  `useFlowSync()` selector subscribing to `session.sync` events.
  One less mirror.
- **Local vs remote is type-honest.** UI components can switch on
  `session.mode === "cloud"` to render the sync chip / collaborator
  panel, with full type narrowing on `session.sync` as
  `RemoteSyncAdapter`.
- **Strict Mode + fast back-button no longer cause WS churn.**
  `SessionRegistry`'s grace period absorbs the double-mount and
  fast-navigation cases. Production behaviour unchanged (no double
  mount, refs go 1→0, destroy after 100ms — perceptually instant).
- **Deletion test passes.** Removing `session/` re-inlines the
  store-plus-four-hooks layout: ~1200 LOC of editing + sync wiring
  reappear in `flow-store.ts` + `use-collab-flow.ts` +
  `use-sync-provider.ts` + `use-flow-document.ts` +
  `sync-state-store.ts` + inlined `localFlowSync` constants in routes.
  The seam concentrates real complexity.
- **Naming reflects the architecture.** `FlowSession`,
  `SyncAdapter`, `RemoteSyncAdapter`, `SessionRegistry`,
  `FlowSessionProvider`, `LocalStorageSyncAdapter`,
  `WebSocketSyncAdapter`, `RecordingSyncAdapter`. Each names one
  responsibility.

**Negative**

- **`SessionRegistry` introduces refcount + deferred destroy.** ~40
  LOC, isolated. The 100ms window means a deliberate close-and-reopen
  within 100ms reuses the previous session — semantically correct (doc
  state hasn't changed) but worth noting as observable behaviour.
- **Provider boundary must wrap every editing UI.** Routes own this
  via `<FlowSessionProvider>` per layout. Components above the provider
  cannot call `useFlowSession()`. In practice this matches current
  call-site distribution (no caller above `/flow/$flowId` needs the
  doc).
- **Migration is one large PR.** 15 call sites + 4 hooks deleted + 1
  store reshaped + 2 routes rewired + new module of ~10 files. No
  backwards-compatibility shims (per `CLAUDE.md`). Trade-off: one PR
  diff, not five with parallel codepaths.
- **Native-runtime push (`FlowUpdateDispatcher`) is deferred.**
  `use-flow-update-dispatcher.ts` is a placeholder hook holding the
  current `setupDocSync` logic verbatim. Naming, broker/provider
  gathering, and the deepening pass land in a follow-up ADR. Risk: the
  placeholder becomes load-bearing and the deepening slips.

**Neutral**

- The `WebSocketSyncAdapter` wraps the existing `SyncProvider` from
  `@microflow/collab`. `SyncProvider` already has the right shape
  (`connect`, `disconnect`, `destroy`, `on(event, cb)`,
  `updateCursor`, `updateSelectedNodes`, `getOtherUsers`). The adapter
  is a thin wrapper, mostly forwarding. If `SyncProvider` later merges
  into the adapter, that's a pure rename.
- The `ReactFlowBridge` (current `useFlowState` reconciler with
  `isSyncingFromYjs` / `pendingYjsSync` / `requestAnimationFrame`)
  moves verbatim into `session/use-react-flow-bridge.ts`. Candidate 2
  from the architecture review will deepen it into a named class with
  its own tests — separate ADR.

## Glossary

New terms recorded in [`CONTEXT.md`](../../CONTEXT.md):

- **FlowSession** — Live editing context wrapping a `FlowDocument` and a
  `SyncAdapter`. Held by a `FlowSessionProvider`, retrieved by
  `useFlowSession()`.
- **SyncAdapter** — Base interface for the session's persistence/sync
  seam. Only carries `destroy()`. Two-tier: extended by
  `RemoteSyncAdapter` for server-backed adapters.
- **RemoteSyncAdapter** — Sub-interface of `SyncAdapter` adding
  `state: SyncState`, `isSynced: boolean`, `users: AwarenessUser[]`,
  `error: Error | null`, `updateCursor`, `updateSelectedNodes`,
  `reconnect`, `disconnect`, `on(event, cb)`. Implemented by
  `WebSocketSyncAdapter` and `RecordingSyncAdapter`. Not implemented by
  `LocalStorageSyncAdapter`.
- **LocalStorageSyncAdapter** — `SyncAdapter` that persists doc updates
  to `localStorage` under `microflow-local-flow`.
- **WebSocketSyncAdapter** — `RemoteSyncAdapter` wrapping the
  `SyncProvider` from `@microflow/collab`. Talks the Yjs sync protocol
  over WebSocket.
- **RecordingSyncAdapter** — `RemoteSyncAdapter` that records inbound
  calls (`appliedUpdates`, `awarenessUpdates`, `connectCalls`,
  `disconnectCalls`) and scripts outcomes (`injectRemoteUpdate`,
  `injectAwareness`, `injectState`, `injectError`). For unit tests; not
  shipped in production bundles.
- **SessionRegistry** — Module-level
  `Map<flowId, { session, refs, pendingDestroy }>` with 100ms
  grace-period destroy. Survives React 18 Strict Mode double-mount and
  fast back-button. Keyed on `flowId`; no cross-mode reuse.
- **FlowSessionProvider** — React Context provider component that owns
  one `FlowSession` for its subtree. One mounted per route layout
  (`LocalFlowLayout`, `CloudFlowLayout`).
- **FlowUpdateDispatcher** — Reserved name. Today a placeholder hook
  (`use-flow-update-dispatcher.ts`) wrapping the current
  `setupDocSync` logic. A follow-up ADR will deepen and rename.

## References

- `apps/web/src/session/` — new module created in this ADR's
  implementation.
- `apps/web/src/stores/flow-store.ts` — reshaped to
  `clipboard-store.ts`.
- `apps/web/src/stores/sync-state-store.ts` — deleted.
- `apps/web/src/hooks/use-collab-flow.ts`,
  `use-sync-provider.ts`, `use-flow-document.ts` — deleted (logic
  moved into `session/`).
- `packages/collab/src/sync-provider.ts` — wrapped by
  `WebSocketSyncAdapter`; unchanged in this ADR.
- `apps/web/src/routes/flow/$flowId.tsx` — `LocalFlowLayout` and
  `CloudFlowLayout` rewired to mount `<FlowSessionProvider>` per
  layout. The inline `localFlowSync` constant deletes.
- [ADR-0001](0001-component-trait-flow-separation.md) — establishes
  the seam discipline on the Rust component side.
- [ADR-0002 — per-capability service traits](0002-per-capability-service-traits.md)
  — `RecordingSyncAdapter` mirrors `RecordingLlmProvider` /
  `RecordingMqttPublisher` discipline.
- [ADR-0002 — `FlowRouter`](0002-flow-router-seam.md) — establishes
  the "two adapters per trait from day one" rule this ADR follows.
- `CONTEXT.md` § FlowSession, SyncAdapter, RemoteSyncAdapter,
  LocalStorageSyncAdapter, WebSocketSyncAdapter, RecordingSyncAdapter,
  SessionRegistry, FlowSessionProvider, FlowUpdateDispatcher.
- `docs/improve-codebase-architecture` candidate 1 (this review).
