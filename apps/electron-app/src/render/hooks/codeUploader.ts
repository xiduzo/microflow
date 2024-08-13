import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DEFAULT_NODE_DATA } from '../../common/nodes';
import { generateCode } from '../../utils/generateCode';
import { useBoard } from '../providers/BoardProvider';
import { nodesAndEdgesCountsSelector, useNodesEdgesStore } from '../store';

// This is outside of the hook to prevent multiple timeouts
// from being created when the hook is called multiple times
let timeout: NodeJS.Timeout | undefined;

export function useCodeUploader() {
	const { checkResult, uploadCode: boardUpload } = useBoard();

	const { updateNodeData, getNodes, getEdges, getInternalNode } =
		useReactFlow();

	const uploadCode = useCallback(() => {
		if (checkResult.type !== 'ready') {
			// TODO: add notification to user?
			return;
		}

		timeout && clearTimeout(timeout);

		timeout = setTimeout(() => {
			const nodes = getNodes();
			const edges = getEdges();

			const nodesWithDefaultValues = nodes.map(node => {
				const data = DEFAULT_NODE_DATA.get(node.type);
				if (data?.value !== undefined) {
					node.data.value = data.value;
				}
				updateNodeData(node.id, node.data);
				return node;
			});

			const internalNodes = nodesWithDefaultValues.map(node =>
				getInternalNode(node.id),
			);
			const allowedEdges = edges.filter(edge => {
				const sourceNode = internalNodes.find(
					node =>
						node.id === edge.source &&
						node.internals.handleBounds.source.find(
							handle => handle.id === edge.sourceHandle,
						),
				);
				const targetNode = internalNodes.find(
					node =>
						node.id === edge.target &&
						node.internals.handleBounds.target.find(
							handle => handle.id === edge.targetHandle,
						),
				);

				return sourceNode && targetNode;
			});

			const code = generateCode(nodes, allowedEdges);

			boardUpload(code);
		}, 1000);
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
