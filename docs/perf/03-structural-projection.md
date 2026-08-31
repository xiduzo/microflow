# The structural projection

A Flow doc holds two kinds of information at once: what the Flow *is* (which
Nodes exist, how they are configured, how they are wired) and how it *looks*
(where each Node sits, how big it is, whether it is selected or mid-drag). The
Author changes the second kind constantly — every drag frame is a doc write.

Three consumers derive something that only the first kind can affect: the
runtime dispatcher, the Arduino sketch generator, and the schematic circuit
builder. All three read the same projection so none of them can drift into its
own idea of what "relevant" means.

## What it is

`projectFlowStructure(nodes, edges)`
(`packages/collab/src/schema.ts:100-121`) returns a `FlowStructure`:

```
{ nodes: [{ id, type, data }], edges: [{ source, sourceHandle, target, targetHandle }] }
```

Both arrays are sorted — nodes by `id`, edges by their four endpoint fields
joined — so a doc reorder with no semantic change projects identically.

`flowStructureKey(nodes, edges)` (`schema.ts:125-130`) is its stable string
identity: `JSON.stringify` of the projection. Two Flows with the same structure
always produce the same key, whatever their layout.

Inputs are structurally typed (`StructuralNodeInput` / `StructuralEdgeInput`,
`schema.ts:75-87`), so collab `FlowNode`s, ReactFlow `Node`s and the runtime's
`FlowUpdate` wire shape all project without adaptation at the call site.

### Fields it strips, and why

| stripped | from | why |
| --- | --- | --- |
| `position` | node | where a Node sits changes nothing a consumer computes — not a netlist, not emitted C++, not a runtime wiring |
| `width`, `height` | node | canvas measurement, written by ReactFlow on every resize observation |
| `selected` | node, edge | editor UI state |
| `dragging` | node | true for the whole duration of a drag, false after |
| `id` | edge | an Edge is identified by its endpoints; its doc key is bookkeeping |
| `type` | edge | the rendered line style (`smoothstep`, etc.) |

Node `type` and node `data` are **kept**: `type` says which kind of Node it is,
`data` is its configuration. Edge endpoints are kept, handles included — the
handle decides which output feeds which input (ADR-0013).

## Who reads it

| consumer | where | what it skips |
| --- | --- | --- |
| runtime dispatcher | `runtimeRelevantKey` (`apps/web/src/session/flow-update-dispatcher.ts:168-183`) | a dispatch that would tear down and rebuild every downstream MQTT/Figma subscription |
| Arduino codegen | `serializeFlowGraph` (`apps/web/src/components/flow/sketch-code-view.model.ts:153-165`) | a full `generate_sketch` round-trip over Tauri IPC |
| schematic circuit | `useFlowStructuralNodes` (`apps/web/src/session/use-flow-nodes.ts:26-42`), consumed by `CircuitBuildListener` (`apps/web/src/routes/flow/$flowId.tsx:51-75`) | a tscircuit worker netlist rebuild |

The dispatcher and the codegen key compare *strings*: each wraps
`projectFlowStructure` with the extra inputs its own output depends on — brokers
and providers for the dispatcher, the selected board `targetId` for codegen —
and compares against the last one it acted on.

`useFlowStructuralNodes` turns the key into a *reference*: it subscribes to the
doc's node observer, computes the key on each change, and calls `setNodes` only
when the key moved. The array it returns therefore keeps its identity across a
drag, which is what stops the `useEffect` in `CircuitBuildListener` from firing.
The mirror-image cost: the retained array carries the positions from the last
structural change, so it must never be used to draw the Flow. Rendering reads
`useFlowNodes` (`use-flow-nodes.ts:5-12`) or the ReactFlow bridge.

## The no-op write guard

Upstream of all of this, `FlowDocument` refuses writes that change nothing.
`setNodeIfChanged` (`packages/collab/src/schema.ts:189-194`) compares the
prospective node against the stored one with `isValueEqual`
(`schema.ts:134-148`, a recursive value comparison — key order is irrelevant,
`undefined` is a value rather than an absent key) and returns before opening a
transaction when they match. `updateNode`, `updateNodePosition` and
`updateNodeData` all route through it; `updateEdge` (`schema.ts:240-248`) applies
the same guard to edges.

The guard lives in the shared document rather than at any call site, because a
Y.Map `set` emits an update whether or not the value changed, and that update
fans out to every observer, the ReactFlow bridge, the runtime dispatcher, the
undo stack and persistence. The most frequent beneficiary is the Leva → Yjs
commit in `useNodeControls`
(`apps/web/src/components/flow/nodes/_base/use-node-controls.tsx:74-79`): Leva's
`controlsData` identity churns on every render, so that effect runs far more
often than the values behind it change.

## Invariants

1. **One definition.** A consumer that must ignore layout reads
   `projectFlowStructure` / `flowStructureKey` / `useFlowStructuralNodes`. It
   does not hand-roll a second field list.
2. **Adding a visual field to `FlowNode` or `FlowEdge` requires no change here.**
   The projection is an allowlist — it names what it keeps, not what it drops —
   so a new visual field is excluded by construction. Adding a field that
   *does* affect a consumer means adding it to `StructuralNode` /
   `StructuralEdge` explicitly.
3. **Sorting stays.** Without it, a doc iteration-order change reads as a
   structural change and every consumer re-runs.
4. **The projection is pure and total.** Same inputs, same output; no reads of
   host state, no throwing on a partially-formed node.
5. **A guarded mutator never swallows a real change.** `isValueEqual` compares
   by value at every depth; a cheaper identity check would drop edits that
   rebuild an object with the same shape but different contents.
6. **Structural identity is not render identity.** `useFlowStructuralNodes`
   returns stale positions on purpose. Anything that positions elements on the
   canvas reads `useFlowNodes` or ReactFlow's own store.

Covered by `packages/collab/src/__tests__/flow-structure.test.ts` and
`apps/web/src/session/__tests__/flow-update-dispatcher.test.ts`.
