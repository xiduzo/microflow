# ADR-0017 — Nest `data` inside the node's Y.Map so concurrent field edits merge

- **Status:** accepted — implemented
- **Date:** 2026-08-28
- **Deciders:** sander

## Context

`FlowDocument` stores nodes as `Y.Map<FlowNode>` where each value is a **plain
JavaScript object** (`packages/collab/src/schema.ts`). Yjs treats such a value
as an opaque atom: it has no visibility into the object's fields, so every
write replaces the whole node.

Every mutator is therefore a read-modify-write over the entire node:

```ts
updateNodeData(nodeId: string, data: Record<string, unknown>): void {
  this.doc.transact(() => {
    const existing = this.nodes.get(nodeId);
    if (existing) {
      this.nodes.set(nodeId, { ...existing, data: { ...existing.data, ...data } });
    }
  }, "local");
}
```

Two clients doing this concurrently do not merge — the CRDT resolves the
conflict at the granularity it can see, which is the whole node, and the later
write wins outright. The earlier client's change is discarded silently, with no
conflict signal anywhere.

The failure is easy to hit with more than two people in a room, and it reads to
users as data loss rather than as a merge:

- A drags a node while B renames it. One of the two edits vanishes on
  convergence — which one depends on message ordering, so it is not
  reproducible and not obviously a bug.
- A and B both open the same Function node's settings. B's saved code
  disappears when A's unrelated `label` edit lands.
- A moves a node while B is mid-drag on it. `position` is contested by two
  whole-node writes rather than by one field.

This is the last item from the collaboration audit
([`COLLAB_SCALING_AUDIT.md`](../COLLAB_SCALING_AUDIT.md) §7) that has not been
addressed. Everything else in that audit is landed; this one is separated out
because, unlike the rest, it **changes the format of every persisted
document**.

## Decision

Store each node as a `Y.Map`, with `data` as a further nested `Y.Map`:

```
nodes: Y.Map<Y.Map<unknown>>
  └─ "<nodeId>": Y.Map
       ├─ id:       string
       ├─ type:     string
       ├─ position: { x, y }        ← plain; x and y always move together
       ├─ width:    number | undefined
       ├─ height:   number | undefined
       └─ data:     Y.Map<unknown>  ← per-field merge
```

`position` deliberately stays a plain object. Its two fields are only ever
written together by a drag, so splitting them buys nothing and costs an extra
level of indirection on the hottest read in the editor.

`edges` stay as they are. An edge is immutable in practice — reconnects
replace endpoints as a unit, and there is no field on an edge that two people
would edit independently.

### Reads keep their current shape

`getNodes()` / `getNode()` continue to return plain `FlowNode` objects,
materialised from the nested maps. No consumer of the read API changes.

### Migration is lazy, not a batch job

There are persisted documents in the database in the current format, and a
Y.Doc update stream cannot be rewritten server-side without invalidating every
client's history. So:

- **Read** accepts both shapes. `nodes.get(id)` returning a plain object means
  a node that has not been upgraded; materialise it directly.
- **Write** always produces the nested shape. The first write to a node
  upgrades it.
- A document therefore converges on the new format through normal use, and a
  flow nobody edits is never touched.

Mixed-format documents are correct at every point, which is what makes a
rolling deploy safe: an old client and a new client can share a room, with the
old client simply not getting per-field merge on nodes the new client has
upgraded.

## Consequences

### The materialisation cache is not optional

This is the part that is easy to miss, and the reason this ADR exists rather
than a patch.

`ReactFlowBridge.mergeYjsIntoSnapshot` preserves object identity for unchanged
nodes, which is what stops one peer's edit from re-rendering every node on
everybody else's canvas (measured at 300x fewer React renders on a 300-node
flow — see `apps/web/bench/bridge-merge.bench.ts`). It does that by comparing
`local.data !== incoming.data` **by reference**, which is exact today precisely
*because* nodes are stored as opaque objects: Yjs hands back the identical
reference for a key nobody wrote.

Materialising a plain object from a `Y.Map` allocates a new object on every
`getNodes()` call. Without care, this ADR silently reverts the single largest
client-side win in the audit.

So the implementation **must** carry a per-node materialisation cache in
`FlowDocument`, invalidated from a deep observer, such that an untouched node
yields the same object reference across calls. This needs to be a stated
invariant with its own test, in the same style as the bridge's five named
invariants (ADR-0004) — not an optimisation someone can remove later without
understanding what it holds up.

### Direct `doc.nodes` access has to go through the seam

`ReactFlowBridge.writeNodesToDoc` currently calls `yMap.set(id, {...node})`
directly, as do the templates, the clipboard paste path, and several tests. All
of those would write the legacy shape and quietly opt their nodes out of
merging.

Every write must move behind a `FlowDocument` method. That is a good change on
its own — the document should own its schema — but it widens the diff
considerably and is the bulk of the work.

### Undo/redo needs re-verification

`Y.UndoManager` is constructed over `[this.nodes, this.edges]` and tracks
origin `"local"`. Nested types inside a tracked map are captured, but the
granularity of an undo step changes: today one node edit is one whole-node
write, afterwards it is one or more field writes inside a transaction. The
`captureTimeout: 500` grouping interacts with this. It needs its own tests
rather than an assumption.

### What we get

- Concurrent edits to different fields of one node merge instead of clobbering.
- Smaller updates on the wire: writing one field sends one field, not the whole
  node with its Function source or LLM prompt attached.

### What we give up

- A more complex document layer, including a cache whose invalidation is load-
  bearing for rendering performance.
- Two read paths (legacy plain object, nested map) for as long as unupgraded
  documents exist, which in practice is indefinitely.

## Alternatives considered

**Leave it.** Defensible while rooms are small — with two people the odds of
touching one node at once are low. It is not defensible for the large-group
case this work is aimed at, and the failure mode is silent data loss, which is
the worst kind to leave in place.

**Nest every field, including `position` as a Y.Map of `x`/`y`.** Maximum merge
granularity, but `x` and `y` are only ever written together, so it adds
indirection on the hottest path for a conflict that cannot occur.

**Last-write-wins with a conflict banner.** Keep the current schema and detect
clobbers, telling the user their change was overwritten. Cheaper, and honest
about what happened — but it reports the problem rather than fixing it, and the
UI for "your edit was discarded, here is what it was" is more work than the
merge.

**Operational transform / a custom merge on top of the opaque value.** Would
mean re-implementing inside the node what Yjs already does correctly one level
up. No.

## What was implemented

All of the above, plus the guards the design called for.

**The merge works.** `flow-document-merge.test.ts` covers two clients editing
disjoint fields of one node, a drag racing a rename, and a whole-node bridge
write racing a field edit. Three of those fail against the previous flat shape;
they are the reason this exists.

**The materialisation cache holds.** `apps/web/bench/bridge-merge.bench.ts`
still reports 300x fewer node re-renders on a 300-node flow after the change —
identical to before it. Dispatcher cost is unchanged too (573ms vs 569ms per
1000 dispatches at 300 nodes), because a cached read costs what the old direct
read did. The cache is invalidated per id from a deep observer registered in the
constructor, so it runs before any consumer callback and consumers never see a
stale entry.

**`onNodesChange` had to become deep.** A change to a node's `data` now fires on
that node's nested map, not on the top-level `nodes` map. A shallow observer
would have missed every field edit — this was the one change that could have
broken the editor silently, and it is why `onNodesChange` uses `observeDeep`.

**Writes moved behind the seam.** `ReactFlowBridge`, the clipboard paste path
and the tests all went through `doc.nodes.set(...)` directly, which would now
write the legacy flat shape and quietly opt those nodes out of merging. They
call `setNode` / `deleteNode` / `setEdge` instead.

**Viewer enforcement got a parity guard.** Adding `setNode` and `deleteNode`
opened a silent hole in `readOnlyDocument`'s `MUTATORS` list — a Viewer could
have written through them. `read-only-mutator-parity.test.ts` now calls every
method on `FlowDocument`, asks the document whether it changed, and fails if
anything writes without being guarded. Verified to fail when a mutator is
removed from the list.

**Undo survives the nesting.** Field edits, position changes and the
origin-scoping that keeps a peer's edit out of our undo stack are all covered.

### The limit of the migration

A node still stored in the legacy flat shape remains an atom until somebody
rewrites it. Two clients concurrently upgrading *the same* legacy node still
resolve last-write-wins on the `nodes` slot — the merge only applies once the
node is nested. In practice the first write upgrades it and every write after
that merges, so the exposure is one edit wide per node. There is a test that
documents this rather than pretending otherwise.
