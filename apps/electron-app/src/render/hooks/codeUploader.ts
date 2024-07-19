import { useReactFlow } from "@xyflow/react";
import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { generateCode } from "../../utils/generateCode";
import { useBoard } from "../providers/BoardProvider";
import {
  nodesAndEdgesCountsSelector,
  useNodesEdgesStore,
} from "../store";

let timeout: NodeJS.Timeout | undefined;

export function useCodeUploader() {
  const { checkResult, uploadCode: boardUpload } = useBoard();

  const { updateNodeData, getNodes, getEdges } = useReactFlow();

  const uploadCode = useCallback(() => {
    if (checkResult.type !== 'ready') {
      // TODO: add notification to user?
      return
    }

    timeout && clearTimeout(timeout)

    timeout = setTimeout(() => {
      const nodes = getNodes();
      const code = generateCode(nodes, getEdges());

      // Reset all nodes values
      nodes.forEach(({ id }) => {
        updateNodeData(id, { value: undefined });
      });

      boardUpload(code);
    }, 1000)
  }, [getNodes, getEdges, updateNodeData, checkResult]);

  return uploadCode;
}

export function useAutoCodeUploader() {
  const uploadCode = useCodeUploader();

  const { nodesCount, edgesCount } = useNodesEdgesStore(
    useShallow(nodesAndEdgesCountsSelector),
  );

  useEffect(() => {
    uploadCode();
  }, [nodesCount, edgesCount, uploadCode]);
}
