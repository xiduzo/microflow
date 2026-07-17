# Sync Architecture

How a Flow moves between the editor, its collaborators, and the runtime. Two
sources of truth, bridged one-directionally:

- The **Yjs `FlowDocument`** is editor truth: node positions/config, edges,
  metadata, presence. It never carries runtime values.
- The **sans-IO Rust runtime** (`microflow-core`, ADR-0006) is execution
  truth. It receives the flow from the doc and reports back through component
  events — never by writing into Yjs.

```
ReactFlow canvas
   │  ▲                       ReactFlowBridge (ADR-0004)
   ▼  │
FlowDocument (Y.Doc) ◄──────► SyncAdapter (ADR-0003) ──► YjsServer ──► Postgres
   │
   ▼  FlowUpdateDispatcher (ADR-0005), debounced, runtime-relevant diff
FlowUpdate (core wire shape, built once)
   │
   ├─ TauriFlowUpdateSender ──► desktop actor (host.rs) ─┐
   └─ WasmFlowUpdateSender ───► FlowReactor ──► wasm ────┤
                                                          ▼
                              Effects (ADR-0008) → component events
                                                          │
                              node-data / signal / dev-log stores ◄┘
                              (canvas value displays + edge signals)
```

## Editor truth: canvas ↔ doc ↔ server

All of this lives in `apps/web/src/session/` (ADR-0003) and
`packages/collab/`.

- **`ReactFlowBridge`** (`session/react-flow-bridge.ts`, ADR-0004) — the
  Yjs↔ReactFlow reconciler behind `useSyncExternalStore`. Ephemeral changes
  (drag frames, selection) stay in the immutable snapshot; structural changes
  are RAF-batched and flushed to the Y.Doc inside a `"local"` transaction.
  `isFlushingToDoc` suppresses the merge-back echo.
- **`FlowDocument`** (`packages/collab/src/schema.ts`) — typed wrapper around
  Y.Doc: `Y.Map("meta" | "nodes" | "edges")`, built-in `UndoManager`,
  `onAnyChange` fires for local *and* remote updates.
- **`SyncAdapter`** (`session/sync-adapter.ts`, ADR-0003) — the persistence
  seam. Adapters: `LocalStorageSyncAdapter` (local flows),
  `WebSocketSyncAdapter` → `SyncProvider` → `YjsServer` → Postgres (cloud
  flows), `RecordingSyncAdapter` (tests). Sessions are refcounted in the
  `SessionRegistry` and delivered via React context.
- **`YjsServer`** (`packages/collab/src/yjs-server.ts`) — one room per
  flowId, broadcast to peers, debounced persistence with ACK.
  `@microflow/collab` vs `@microflow/collab/server` keeps Node-only deps out
  of the browser bundle.

## Doc → runtime: one wire shape

- **`FlowUpdateDispatcher`** (`session/flow-update-dispatcher.ts`, ADR-0005)
  observes `doc.onAnyChange`, debounces, and builds the payload with the pure
  `buildFlowUpdate`. `runtimeRelevantKey` hashes only what the runtime
  consumes (node id/type/data, edge endpoints, brokers, providers) so a pure
  node move never re-dispatches — that is what keeps downstream MQTT/Figma
  subscriptions from churning on drags (ADR-0010 keeps the desired→live
  subscription diff per-host).
- **The wire shape is core's `FlowUpdate`** (`crates/microflow-core/src/flow.rs`,
  ts-rs bindings in `apps/web/src/lib/bindings/`). `buildFlowUpdate` is the
  single place the collab shapes are projected into it: visual-only fields
  dropped, optional edge handles defaulted to `""` (core requires them).
  Both senders forward it untouched.
- **`FlowUpdateSender`** (`session/flow-update-sender.ts`) — the transport
  seam. `TauriFlowUpdateSender` invokes the desktop `flow_update` command
  (plus broker/provider infra config); `WasmFlowUpdateSender` hands
  `{nodes, edges}` to the browser `FlowReactor` (cloud config is resolved
  live from stores via `CloudDeps`, ADR-0009).

## Runtime → UI: component events, not Yjs

Each runtime turn returns `Effects`, applied in canonical order (ADR-0008,
`effects-sink.ts` mirroring Rust `Effects::apply`). Component events funnel
through `applyComponentEvent` (`lib/event-ingest.ts`) on both platforms —
desktop via the `component-event` Tauri event, browser via the
`FlowReactor` — into the `node-data`, `signal`, and `dev-log` stores that the
canvas reads for value displays and edge-signal animations. Runtime values
never enter the Y.Doc.

## Key design decisions

1. **Two truths, one-way bridge** — the doc drives the runtime; the runtime
   reports through stores. No write cycle to guard between them.
2. **One `FlowUpdate` projection** — the Rust struct is the single source
   (ts-rs), built once in `buildFlowUpdate`; senders are pure transports.
3. **Y.Map over Y.Array** — O(1) node updates.
4. **Snapshot-first canvas** — ReactFlow gets synchronous updates for smooth
   dragging; Yjs gets RAF-batched structural writes.
5. **Runtime-relevant diffing** — position/selection churn never reaches the
   runtime or its subscriptions.
