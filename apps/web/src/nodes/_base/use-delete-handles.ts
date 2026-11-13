import { useUpdateNodeInternals } from "@xyflow/react";
import { useCallback } from "react";
import { removeEdgesAtHandles, useFlowSession } from "@/session";
import { useNodeId } from "./node-context";

/**
 * Forces deletion of rendered handles, plus any edges connected to them, on a node.
 * Useful for nodes whose handle set is data-driven (e.g. a Function node whose
 * inputs/outputs vary with its config).
 *
 * The edges go through `removeEdgesAtHandles`, i.e. `FlowDocument.removeEdge`,
 * so a Viewer's read-only document turns this into a no-op. Deleting on the raw
 * `doc.edges` Y.Map, as this used to, slipped underneath that guard.
 */
export function useDeleteHandles() {
  const id = useNodeId();
  const { doc } = useFlowSession();
  const updateNodeInternals = useUpdateNodeInternals();

  const deleteHandles = useCallback(
    (handles: string[]) => {
      removeEdgesAtHandles(doc, id, handles);
      updateNodeInternals(id);
    },
    [id, doc, updateNodeInternals],
  );

  return deleteHandles;
}
