import { useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { deleteEdgesSelector, useNodesEdgesStore } from "../store";
import { useCodeUploader } from "./codeUploader";

export function useUpdateNodeData<T extends Record<string, any>>(nodeId: string) {
  const { updateNodeData: internalUpdateNodeData } = useReactFlow();
  const uploadCode = useCodeUploader();


  function updateNodeData(data: Partial<T>) {
    internalUpdateNodeData(nodeId, data);
    uploadCode()
  }

  return { updateNodeData };
}

export function useUpdateNodesHandles(nodeId:string) {
  const updateNodeInternals = useUpdateNodeInternals();


  const { deleteEdges } = useNodesEdgesStore(
    useShallow(deleteEdgesSelector),
  );

  function updateNodesHandles() {
    updateNodeInternals(nodeId);
    deleteEdges(nodeId);
  }

  return { updateNodesHandles };
}
