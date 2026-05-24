import { useUpdateNodeInternals } from "@xyflow/react";
import { useCallback } from "react";
import { useFlowSession } from "@/session";
import { useNodeId } from "./_base";

/**
 * Forces deletion of rendered handles, plus any edges connected to them, on a node.
 * Useful for nodes whose handle set is data-driven (e.g. a Function node whose
 * inputs/outputs vary with its config).
 */
export function useDeleteHandles() {
  const id = useNodeId();
  const { doc } = useFlowSession();
  const updateNodeInternals = useUpdateNodeInternals();

  const deleteHandles = useCallback(
    (handles: string[]) => {
      const edges = doc.getEdges();
      const edgesToRemove = edges.filter(
        (edge) =>
          (edge.source === id && edge.sourceHandle && handles.includes(edge.sourceHandle)) ||
          (edge.target === id && edge.targetHandle && handles.includes(edge.targetHandle)),
      );

      if (edgesToRemove.length > 0) {
        doc.doc.transact(() => {
          for (const edge of edgesToRemove) doc.edges.delete(edge.id);
        }, "local");
      }

      updateNodeInternals(id);
    },
    [id, doc, updateNodeInternals],
  );

  return deleteHandles;
}
