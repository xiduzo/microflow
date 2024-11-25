import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useRef } from 'react';
import { generateCode, isNodeTypeACodeType } from '../../utils/generateCode';
import { useNodeAndEdgeCount } from '../stores/react-flow';
import { useBoardPort, useBoardResult, useBoardStore } from '../stores/board';
import { UploadResult } from '../../common/types';
import { toast } from '@ui/index';
import { useClearNodeData } from '../stores/node-data';
import { useNewNode } from '../providers/NewNodeProvider';

export function useCodeUploader() {
	const clearNodeData = useClearNodeData();
	const boardResult = useBoardResult();
	const port = useBoardPort();
	const { setUploadResult } = useBoardStore();

	const { updateNodeData, getNodes, getEdges, getInternalNode } = useReactFlow();

	const uploadCode = useCallback(() => {
		if (boardResult !== 'ready') return;

		clearNodeData();
		setUploadResult({ type: 'info' });

		const nodes = getNodes().filter(node => {
			if (!isNodeTypeACodeType(node.type)) return;
			return node;
		});
		const edges = getEdges();

		const internalNodes = nodes.map(node => getInternalNode(node.id));
		const allowedEdges = edges.filter(edge => {
			const sourceNode = internalNodes.find(
				node =>
					node.id === edge.source &&
					(node.internals.handleBounds?.source?.find(handle => handle.id === edge.sourceHandle) ??
						true),
			);
			const targetNode = internalNodes.find(
				node =>
					node.id === edge.target &&
					(node.internals.handleBounds?.target?.find(handle => handle.id === edge.targetHandle) ??
						true),
			);

			return sourceNode && targetNode;
		});

		const code = generateCode(nodes, allowedEdges);

		const off = window.electron.ipcRenderer.on('ipc-upload-code', (result: UploadResult) => {
			setUploadResult(result);

			if (result.type !== 'info') off();
			if (result.type === 'error') toast.error(result.message);
		});

		window.electron.ipcRenderer.send('ipc-upload-code', code, port);
	}, [
		getNodes,
		getEdges,
		updateNodeData,
		getInternalNode,
		boardResult,
		setUploadResult,
		port,
		clearNodeData,
	]);

	return uploadCode;
}

export function useAutoCodeUploader() {
	const uploadCode = useCodeUploader();
	const { nodeToAdd } = useNewNode();
	const boardResult = useBoardResult();
	const debounce = useRef<NodeJS.Timeout>();

	const { nodesCount, edgesCount } = useNodeAndEdgeCount();

	const lastNodesCount = useRef(-1);
	const lastEdgesCount = useRef(-1);

	useEffect(() => {
		if (nodeToAdd?.length) return;
		if (boardResult !== 'ready') return;

		if (lastNodesCount.current === nodesCount && lastEdgesCount.current === edgesCount) return;

		lastNodesCount.current = nodesCount;
		lastEdgesCount.current = edgesCount;

		debounce.current = setTimeout(() => {
			uploadCode();
		}, 1_000);

		return () => {
			clearTimeout(debounce.current);
		};
	}, [nodesCount, edgesCount, uploadCode, boardResult, nodeToAdd]);
}
