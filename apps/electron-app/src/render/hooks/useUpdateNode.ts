import { useReactFlow } from '@xyflow/react';
import { useCallback } from 'react';
import { useCodeUploader } from './useCodeUploader';
import { useNodesChange } from '../stores/react-flow';

export function useUpdateNode<T extends Record<string, any>>(nodeId: string) {
	const { getNode } = useReactFlow();
	const uploadCode = useCodeUploader();
	const onNodesChange = useNodesChange();

	const updateNode = useCallback(
		(data: T, updateCode = true) => {
			const node = getNode(nodeId);

			onNodesChange([{ id: nodeId, type: 'replace', item: { ...node!, data } }]);

			if (!updateCode) return;

			setTimeout(() => {
				uploadCode();
			}, 50); // Give xyFlow some time to process the update
		},
		[uploadCode, getNode, nodeId, onNodesChange],
	);

	return updateNode;
}
