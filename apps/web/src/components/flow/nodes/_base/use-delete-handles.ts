import { useUpdateNodeInternals } from "@xyflow/react";
import { useCallback } from "react";
import { useFlowStore } from "@/stores/flow-store";
import { useNodeId } from "./_base";

/**
 * Forces deletion of rendered handles, plus any edges connected to them, on a node.
 * Useful for nodes whose handle set is data-driven (e.g. a Function node whose
 * inputs/outputs vary with its config).
 */
export function useDeleteHandles() {
  const id = useNodeId();
  const flowDoc = useFlowStore((state) => state.flowDoc);
  const onEdgesChange = useFlowStore((state) => state.onEdgesChange);
  const updateNodeInternals = useUpdateNodeInternals();

  const deleteHandles = useCallback(
    (handles: string[]) => {
      if (!flowDoc) return;

      // Find edges connected to the specified handles on this node
      const edges = flowDoc.getEdges();
      const edgesToRemove = edges.filter(
        (edge) =>
          (edge.source === id && edge.sourceHandle && handles.includes(edge.sourceHandle)) ||
          (edge.target === id && edge.targetHandle && handles.includes(edge.targetHandle)),
      );

      // Remove each edge by its actual edge ID
      if (edgesToRemove.length > 0) {
        onEdgesChange(edgesToRemove.map((edge) => ({ id: edge.id, type: "remove" })));
      }

      updateNodeInternals(id); // for xyflow to apply the changes of the removed handles
    },
    [id, flowDoc, onEdgesChange, updateNodeInternals],
  );

  return deleteHandles;
}
