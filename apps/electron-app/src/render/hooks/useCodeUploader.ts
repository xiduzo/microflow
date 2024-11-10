import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { generateCode, isNodeTypeACodeType } from '../../utils/generateCode';
import { nodesAndEdgesCountsSelector, useNodesEdgesStore } from '../stores/react-flow';
import { useBoardPort, useBoardResult, useBoardStore } from '../stores/board';
import { UploadResult } from '../../common/types';
import { toast } from '@ui/index';

export function useCodeUploader() {
	const boardResult = useBoardResult();
	const port = useBoardPort();
	const { setUploadResult } = useBoardStore();

	const { updateNodeData, getNodes, getEdges, getInternalNode } = useReactFlow();

	const uploadCode = useCallback(() => {
		if (boardResult !== 'ready') return;

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
	}, [getNodes, getEdges, updateNodeData, getInternalNode, boardResult, setUploadResult, port]);

	return uploadCode;
}

export function useAutoCodeUploader() {
	const uploadCode = useCodeUploader();
	const boardResult = useBoardResult();

	const { nodesCount, edgesCount } = useNodesEdgesStore(useShallow(nodesAndEdgesCountsSelector));

	useEffect(() => {
		if (boardResult !== 'ready') return;

		uploadCode();
	}, [nodesCount, edgesCount, uploadCode, boardResult]);
}
