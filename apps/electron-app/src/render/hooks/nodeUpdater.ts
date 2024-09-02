import { useReactFlow } from '@xyflow/react';
import { useCallback } from 'react';
import { useCodeUploader } from './useCodeUploader';

export function useUpdateNode<T extends Record<string, any>>(nodeId: string) {
	const { updateNodeData } = useReactFlow();
	const uploadCode = useCodeUploader();

	const updateNode = useCallback(
		(data: Partial<T>, updateCode = true) => {
			updateNodeData(nodeId, data);

			if (!updateCode) {
				return;
			}

			uploadCode();
		},
		[uploadCode, updateNodeData, nodeId],
	);

	return updateNode;
}
