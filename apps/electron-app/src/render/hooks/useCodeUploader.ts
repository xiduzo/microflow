import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useRef } from 'react';
import { generateCode, isNodeTypeACodeType } from '../../utils/generateCode';
import { useNodeAndEdgeCount } from '../stores/react-flow';
import { useBoardPort, useBoardResult, useBoardStore, useUploadResult } from '../stores/board';
import { UploadRequest, UploadResponse } from '../../common/types';
import { toast } from '@ui/index';
import { useClearNodeData } from '../stores/node-data';
import { useLocalStorage } from 'usehooks-ts';
import { AdvancedConfig } from '../components/forms/AdvancedSettingsForm';
import { useShallow } from 'zustand/react/shallow';
import { useNewNodeStore } from '../stores/new-node';

export function useCodeUploader() {
	const clearNodeData = useClearNodeData();
	const boardResult = useBoardResult();

	const port = useBoardPort();
	const [config] = useLocalStorage<AdvancedConfig>('advanced-config', { ip: undefined });
	const { setUploadResult, setBoardResult } = useBoardStore();

	const { updateNodeData, getNodes, getEdges, getInternalNode } = useReactFlow();

	const uploadCode = useCallback(() => {
		console.time('uploadCode');
		if (boardResult !== 'ready') return;
		if (!config.ip && !port) return;

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
					node?.id === edge.source &&
					(node?.internals.handleBounds?.source?.find(handle => handle.id === edge.sourceHandle) ??
						true),
			);
			const targetNode = internalNodes.find(
				node =>
					node?.id === edge.target &&
					(node?.internals.handleBounds?.target?.find(handle => handle.id === edge.targetHandle) ??
						true),
			);

			return sourceNode && targetNode;
		});

		const code = generateCode(nodes, allowedEdges);

		console.time('send');
		window.electron.ipcRenderer.send<UploadRequest>('ipc-upload-code', {
			code,
			port: config.ip || port || '',
		});
		console.timeEnd('send');
		console.timeEnd('uploadCode');
	}, [
		getNodes,
		getEdges,
		updateNodeData,
		getInternalNode,
		boardResult,
		setUploadResult,
		port,
		config.ip,
		clearNodeData,
	]);

	useEffect(() => {
		return window.electron.ipcRenderer.on<UploadResponse>('ipc-upload-code', result => {
			if (!result.success) {
				toast.error(result.error);
				return;
			}

			setUploadResult(result.data);

			switch (result.data.type) {
				case 'close':
					toast.warning(result.data.message);
					setBoardResult({ type: 'close' });
					window.electron.ipcRenderer.send('ipc-check-board', { ip: config.ip });
					break;
				case 'error':
					toast.error(result.data.message);
					break;
			}
		});
	}, [config.ip]);

	return uploadCode;
}

export function useAutoCodeUploader() {
	const uploadCode = useCodeUploader();
	const nodeToAdd = useNewNodeStore(useShallow(state => state.nodeToAdd));
	const boardResult = useBoardResult();
	const uploadResult = useUploadResult();
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

	useEffect(() => {
		if (uploadResult !== 'close') return;

		lastNodesCount.current = -1;
		lastEdgesCount.current = -1;
	}, [boardResult]);
}
