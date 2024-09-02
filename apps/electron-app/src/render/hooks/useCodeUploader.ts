import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DEFAULT_NODE_DATA } from '../../common/nodes';
import { generateCode, isNodeTypeACodeType } from '../../utils/generateCode';
import { useBoard } from '../providers/BoardProvider';
import { nodesAndEdgesCountsSelector, useNodesEdgesStore } from '../store';

export function useCodeUploader() {
	const { uploadCode: boardUpload, checkResult } = useBoard();

	const { updateNodeData, getNodes, getEdges, getInternalNode } = useReactFlow();

	const uploadCode = useCallback(() => {
		if (checkResult !== 'ready') {
			return;
		}

		const nodes = getNodes().filter(node => {
			if (!isNodeTypeACodeType(node.type)) {
				return;
			}
			return node;
		});
		const edges = getEdges();

		const nodesWithDefaultValues = nodes.map(node => {
			const data = DEFAULT_NODE_DATA.get(node.type);
			if (data?.value !== undefined) {
				node.data.value = data.value;
			}
			updateNodeData(node.id, node.data);
			return node;
		});

		const internalNodes = nodesWithDefaultValues.map(node => getInternalNode(node.id));
		const allowedEdges = edges.filter(edge => {
			const sourceNode = internalNodes.find(
				node =>
					node.id === edge.source &&
					node.internals.handleBounds.source?.find(handle => handle.id === edge.sourceHandle),
			);
			const targetNode = internalNodes.find(
				node =>
					node.id === edge.target &&
					node.internals.handleBounds.target?.find(handle => handle.id === edge.targetHandle),
			);

			return sourceNode && targetNode;
		});

		const code = generateCode(nodes, allowedEdges);

		boardUpload(code);
	}, [getNodes, getEdges, updateNodeData, boardUpload, getInternalNode, checkResult]);

	return uploadCode;
}

export function useAutoCodeUploader() {
	const uploadCode = useCodeUploader();
	const { checkResult } = useBoard();

	const { nodesCount, edgesCount } = useNodesEdgesStore(useShallow(nodesAndEdgesCountsSelector));

	useEffect(() => {
		if (checkResult !== 'ready') {
			return;
		}

		uploadCode();
	}, [nodesCount, edgesCount, uploadCode, checkResult]);
}
