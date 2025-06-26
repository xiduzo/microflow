import { useReactFlow, Node } from '@xyflow/react';
import { useCallback } from 'react';
import { useCodeUploader } from './useCodeUploader';
import { useNodesChange } from '../stores/react-flow';

export function useUpdateNode<T extends Record<string, any>>(nodeId: string) {
	const { getNode } = useReactFlow();
	const {uploadCode, nodeChanged} = useCodeUploader();
	const onNodesChange = useNodesChange();

	const updateNode = useCallback(
		(data: T, updateCode = true) => {
			const node = getNode(nodeId);

			if(!node) return;

			const item = { ...node!, data: { ...node!.data, ...data } }
			onNodesChange([
				{ id: nodeId, type: 'replace', item },
			]);

			if (!updateCode) return;

			setTimeout(() => {
				nodeChanged(item);
			}, 50); // Give xyFlow some time to process the update
		},
		[nodeChanged, getNode, nodeId, onNodesChange],
	);

	return updateNode;
}
