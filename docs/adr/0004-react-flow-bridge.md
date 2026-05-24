# ADR-0004 — `ReactFlowBridge` class extraction, with named invariants and `useSyncExternalStore`

- **Status:** accepted
- **Date:** 2026-05-23
- **Deciders:** sander

## Context

[ADR-0003](0003-flow-session-seam.md) extracted the editing + sync layer
into `FlowSession`, but explicitly deferred deepening of the Yjs ↔
ReactFlow reconciler (originally `useFlowState` in
`apps/web/src/hooks/use-flow-document.ts`, moved verbatim to
`apps/web/src/session/use-react-flow-bridge.ts` as a hook). That move
preserved behaviour but left ~110 LOC of anonymous mechanism in a single
hook:

- `pendingYjsSync` ref — both a loop guard ("is a local sync pending?")
  and a payload carrier (what to flush).
- `isSyncingFromYjs` ref — never actually read; dead defensive code.
- Inline `hasStructuralChange` predicate inside `onNodesChange` /
  `onEdgesChange` — same rule duplicated for each side, no shared name.
- Inline merge of `selected` / `dragging` from React state onto Yjs
  snapshots — the "local-only fields never round-trip" invariant lived
  embedded in a `setNodes((current) => ...)` updater.
- Inline diff "only write to Y.Map if position or dimensions changed"
  also embedded in the flush.
- `requestAnimationFrame(syncToYjs)` for batching, with no name for the
  batched flush.

The friction this caused:

- **Untestable without React.** Verifying "drag-during does not pollute
  the doc" required mounting a component with `@testing-library/react`,
  firing `applyNodeChanges`, awaiting an `act()` boundary, asserting on
  `flowDoc.getNodes()`. The thing being tested — a classification rule
  + a write rule — is pure logic.
- **Invariants invisible to grep.** "Where does the bridge decide
  drag-during is ephemeral?" had no answer beyond reading the whole
  hook. Same for "where does the loop guard live?" and "where is the
  diff?".
- **`pendingYjsSync` doing two jobs.** As payload carrier it held the
  React state to flush; as loop guard it indicated "skip the Yjs→React
  merge." Both were tangled — when `pendingYjsSync.current = null` ran
  inside the flush, the synchronous Y.Map observer fire then ran the
  merge against the just-written state, producing a redundant
  React-state rebuild on every flush.
- **Cannot reason about Strict Mode.** Hooks-on-mount semantics aren't
  the same as construct-once semantics; reasoning about double-mount
  required tracing ref + effect interactions across multiple closures.

The skill review (candidate 2) called the reconciler "deep but
anonymous" and asked for "a `ReactFlowBridge` interface that has Y.Doc
on one side and React `setState` on the other." This ADR delivers that.

## Decision

Introduce a `ReactFlowBridge` class in
`apps/web/src/session/react-flow-bridge.ts`. The class is the
**External Store** for `useSyncExternalStore`; the hook
`useReactFlowBridge(doc)` is a thin React adapter.

```text
┌─ Static classification rules (pure) ──────────────────────┐
│  ReactFlowBridge.classifyNodeChange(c) → "structural" | "ephemeral"
│  ReactFlowBridge.classifyEdgeChange(c) → "structural" | "ephemeral"
│  ReactFlowBridge.nodeNeedsWrite(local, yjs?) → boolean
│  ReactFlowBridge.mergeYjsIntoSnapshot(yjsNodes, localNodes) → FlowNode[]
│  ReactFlowBridge.mergeEdgesYjsIntoSnapshot(yjsEdges, localEdges) → FlowEdge[]
└────────────────────────────────────────────────────────────┘
┌─ Instance (per FlowDocument) ─────────────────────────────┐
│  constructor(doc) — subscribes to doc.onNodesChange /     │
│      doc.onEdgesChange; reads initial snapshot.            │
│  subscribe(listener) / getSnapshot() — useSyncExternalStore
│      contract; snapshot reference stable between mutations.│
│  applyNodeChanges(changes) / applyEdgeChanges(changes) —   │
│      update snapshot, notify listeners, schedule flush if  │
│      any structural change present.                        │
│  flush() — public, synchronous. Writes pending snapshot to │
│      Y.Doc inside one transact("local"). Called by RAF in  │
│      production; called directly by tests and write-barrier│
│      callers (e.g. before navigation).                     │
│  destroy() — unobserve, cancel RAF, clear listeners;       │
│      idempotent. Post-destroy methods are no-ops.          │
└────────────────────────────────────────────────────────────┘
┌─ React adapter (thin) ────────────────────────────────────┐
│  function useReactFlowBridge(doc: FlowDocument) {          │
│    const [bridge] = useState(() => new ReactFlowBridge(doc));
│    useEffect(() => () => bridge.destroy(), [bridge]);      │
│    const snap = useSyncExternalStore(                      │
│      bridge.subscribe, bridge.getSnapshot                  │
│    );                                                      │
│    return { nodes, edges, onNodesChange, onEdgesChange };  │
│  }                                                         │
└────────────────────────────────────────────────────────────┘
```

Five sub-decisions:

- **D1 — Class as the external store, not pure-functions-in-hook.** The
  bridge holds mutable state (pending flush, loop guard, listeners). A
  class makes those fields explicit and named; a hook-of-functions
  would put them in `useRef` closures with no obvious name. The class
  is also testable without React — vitest constructs one, calls
  methods, asserts on the doc. The pure-helpers-in-hook alternative
  loses the integration test surface.

- **D2 — `useSyncExternalStore`, not a React state mirror.** The
  bridge's snapshot is the canonical React-visible state; React reads
  it via `getSnapshot()`. The bridge mutates `this.currentSnapshot`
  immutably (`{ ...this.currentSnapshot, nodes: next }`) and calls
  `notify()`. `useSyncExternalStore` then schedules React's render.
  This is the React 18-blessed pattern for external stores and avoids
  the duplicate-state pitfall of `useState`-mirroring-class-state.

- **D3 — Loop guard via `isFlushingToDoc` boolean, not `pendingYjsSync`
  payload.** Y.Map observers fire synchronously inside `transact`. The
  flush sets `this.isFlushingToDoc = true` for the duration of the
  transact; observers check the flag and skip the merge. Cleaner than
  the legacy "if `pendingYjsSync.current` then skip" because the guard
  is explicitly scoped to the bridge's own write, not to "any pending
  flush state."

- **D4 — RAF batching plus a public `flush()`.** Production calls
  `scheduleFlush` (one `requestAnimationFrame` queues the writes; later
  `applyNodeChanges` calls in the same frame piggy-back). Tests call
  `flush()` directly so they can assert synchronously without awaiting
  a paint frame. The method is also a write barrier — a caller about
  to navigate or destroy the session can force pending writes to Y.Doc
  first.

- **D5 — `useState` lazy init for Strict Mode-safe construction.** The
  bridge owns subscriptions and a RAF handle; constructing it in
  `useMemo` would leak observers on Strict Mode's recomputation.
  `useState(() => new ReactFlowBridge(doc))` initializes once per
  state slot; `useEffect(() => () => bridge.destroy(), [bridge])`
  cleans up symmetrically. Strict Mode's mount → unmount → mount cycle
  produces bridge1 (destroyed on the intermediate unmount) → bridge2
  (destroyed on real unmount). No leaks. `doc` is invariant for the
  hook's lifetime via the `FlowSession` contract — a `FlowSession`
  never swaps its doc — so the bridge identity is stable.

Roll out as one pure-addition PR:

1. Add `react-flow-bridge.ts` (class).
2. Rewrite `use-react-flow-bridge.ts` as thin hook (`useState` + `useEffect`
   + `useSyncExternalStore`).
3. Add `__tests__/react-flow-bridge.test.ts` — 28 vitest cases.

No call-site changes — the hook signature is preserved.

## Consequences

**Positive**

- **The reconciler is unit-testable without React.** 28 tests across 5
  groups: Yjs→React (7), React→Yjs (13), lifecycle (4), convergence (1),
  classification helpers (3). Convergence test wires two bridges + two
  docs + two `RecordingSyncAdapter`s — proves CRDT replay end-to-end
  without `@testing-library/react`.
- **Every invariant has a name and a method.** Grep for
  `classifyNodeChange`, `mergeYjsIntoSnapshot`, `nodeNeedsWrite`,
  `isFlushingToDoc`, `scheduleFlush` to find each rule. Reading the
  bridge is reading a list of named operations, not tracing closures.
- **Loop guard simpler.** `isFlushingToDoc` is a boolean set for the
  duration of the synchronous transact. The legacy `pendingYjsSync`
  trick conflated guard + payload; the new design separates them.
- **Public `flush()` is a write barrier.** Tests use it for
  deterministic assertions; production can use it before destroying a
  session (e.g. "flush before unmount" to avoid losing in-flight RAF
  writes). Today the only caller is the test suite; available when
  needed.
- **Deletion test passes.** Removing `react-flow-bridge.ts` re-inlines
  the legacy hook — five invariants reappear in five anonymous places,
  ~200 LOC of mechanism with no name. The seam concentrates real
  complexity.

**Negative**

- **One more class to learn.** ~230 LOC including tests, isolated to
  one file. The hook is now 30 LOC.
- **`flush()` is part of the public surface.** Callers could misuse it
  (force-flush during drag, causing extra undo entries). Documented in
  the source as "use only as a write barrier."
- **Bridge identity is component-scoped, not session-scoped.** Two
  canvases mounted against one session would race (two bridges, two
  flushes, two sets of writes). Acceptable because no caller mounts
  two canvases — and putting the bridge in `FlowSession` would couple
  the session to ReactFlow's protocol, which is exactly what the
  bridge exists to isolate.

**Neutral**

- **Drag-during sync still local-only.** This ADR preserves the prior
  behaviour (drag-end-only writes to Y.Doc). The right channel for
  ephemeral peer state is Yjs awareness, not the doc; broadcasting
  drag-during over `RemoteSyncAdapter` awareness is a separate enhancement
  noted in `CONTEXT.md` § ReactFlowBridge and out of scope here.

## Glossary

New terms recorded in [`CONTEXT.md`](../../CONTEXT.md):

- **ReactFlowBridge** — Bidirectional reconciler between a `FlowDocument`
  (Y.Doc CRDT) and the [ReactFlow](https://reactflow.dev) change
  protocol. Class instance per canvas mount.
- **classifyNodeChange / classifyEdgeChange** — Pure rules that map a
  ReactFlow change to `"structural"` (flows to Y.Doc) or `"ephemeral"`
  (local React state only).
- **mergeYjsIntoSnapshot** — Pure rule that preserves local-only fields
  (`selected`, `dragging`) when an incoming Y.Doc snapshot replaces the
  current React snapshot.
- **nodeNeedsWrite** — Pure diff rule that skips Y.Doc writes when
  position + dimensions are unchanged.
- **isFlushingToDoc** — Bridge instance flag, true only during the
  synchronous `transact("local")`, that suppresses the Yjs→React
  merge-back of the bridge's own write.

## References

- `apps/web/src/session/react-flow-bridge.ts` — class implementation.
- `apps/web/src/session/use-react-flow-bridge.ts` — React adapter.
- `apps/web/src/session/__tests__/react-flow-bridge.test.ts` — 28 tests.
- [ADR-0003](0003-flow-session-seam.md) — established the surrounding
  `FlowSession` seam; this ADR deepens the candidate-2 placeholder
  identified in ADR-0003's "Neutral" consequences.
- [`docs/improve-codebase-architecture`](../../.claude/skills/improve-codebase-architecture/SKILL.md)
  candidate 2 — the architecture review opportunity this ADR closes.
- `CONTEXT.md` § ReactFlowBridge.
