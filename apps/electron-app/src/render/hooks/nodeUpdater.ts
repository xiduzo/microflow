import { useReactFlow } from "@xyflow/react";
import { useCodeUploader } from "./codeUploader";

export function useUpdateNodeData<T extends Record<string, unknown>>(nodeId: string) {
  const { updateNodeData: internalUpdateNodeData } = useReactFlow();
  const uploadCode = useCodeUploader();


  function updateNodeData(data: Partial<T>) {
    internalUpdateNodeData(nodeId, data);
    uploadCode()
  }

  return { updateNodeData };
}
