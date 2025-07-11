import { useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import { useCallback } from 'react';
import { useCodeUploader } from './useCodeUploader';
import { useNodesChange } from '../stores/react-flow';

export function useUpdateNode<T extends Record<string, unknown>>(nodeId: string) {
	const { getNode } = useReactFlow();
	const uploadCode = useCodeUploader();
	const onNodesChange = useNodesChange();
	const updateNodeInternals = useUpdateNodeInternals();

	const updateNode = useCallback(
		(data: T) => {
			const node = getNode(nodeId);

			console.log('<updateNode>', node, data);
			onNodesChange([
				{ id: nodeId, type: 'replace', item: { ...node!, data: { ...node!.data, ...data } } },
			]);

			updateNodeInternals(nodeId);
		},
		[uploadCode, getNode, nodeId, onNodesChange, updateNodeInternals],
	);

	return updateNode;
}
