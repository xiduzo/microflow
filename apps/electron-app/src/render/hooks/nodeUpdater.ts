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

			setTimeout(() => {
				uploadCode();
			}, 150); // Sometimes we need to give the UI a bit of a head-start so we put this on eventloop queue for later
		},
		[uploadCode, updateNodeData, nodeId],
	);

	return updateNode;
}
