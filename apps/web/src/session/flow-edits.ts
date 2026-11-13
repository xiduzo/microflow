import type { FlowDocument } from "@microflow/collab";

/**
 * Compound edits on a `FlowDocument` that every caller must do the same way.
 *
 * Each one is composed only from `FlowDocument`'s public mutators. That is the
 * point of the module: the session's `readOnlyDocument` proxy guards exactly
 * those mutators, so an edit made here is a no-op for a Viewer without the
 * caller remembering to check — unlike a raw `doc.edges.delete`, which reaches
 * the Y.Map underneath the proxy and writes anyway.
 */

/** The slice of `FlowDocument` these edits use. */
type EditableDoc = Pick<FlowDocument, "doc" | "getEdges" | "removeEdge" | "deleteNode">;

/**
 * Remove nodes together with every edge attached to them, as one local
 * transaction (one undo step).
 *
 * The single definition of "delete a node" for code that is not ReactFlow
 * itself. Deleting only the node leaves edges pointing at nothing in the doc —
 * invisible on the canvas, but still read by every consumer of the edge list
 * (the runtime, codegen, the AI's view of the flow).
 *
 * Returns the ids of the edges it removed.
 */
export function removeNodesWithEdges(doc: EditableDoc, nodeIds: Iterable<string>): string[] {
  const ids = new Set(nodeIds);
  if (ids.size === 0) return [];
  const removedEdges: string[] = [];
  doc.doc.transact(() => {
    for (const edge of doc.getEdges()) {
      if (!ids.has(edge.source) && !ids.has(edge.target)) continue;
      doc.removeEdge(edge.id);
      removedEdges.push(edge.id);
    }
    for (const id of ids) doc.deleteNode(id);
  }, "local");
  return removedEdges;
}

/**
 * Remove every edge attached to the given handles of one node, as one local
 * transaction. For nodes whose handle set is data-driven: a handle that stops
 * existing must take its edges with it.
 *
 * Returns the ids of the edges it removed.
 */
export function removeEdgesAtHandles(
  doc: EditableDoc,
  nodeId: string,
  handles: readonly string[],
): string[] {
  if (handles.length === 0) return [];
  const removed = doc
    .getEdges()
    .filter(
      (edge) =>
        (edge.source === nodeId && !!edge.sourceHandle && handles.includes(edge.sourceHandle)) ||
        (edge.target === nodeId && !!edge.targetHandle && handles.includes(edge.targetHandle)),
    )
    .map((edge) => edge.id);
  if (removed.length === 0) return [];
  doc.doc.transact(() => {
    for (const id of removed) doc.removeEdge(id);
  }, "local");
  return removed;
}
