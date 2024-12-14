import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useRef } from 'react';
import { generateCode, isNodeTypeACodeType } from '../../utils/generateCode';
import { useNodeAndEdgeCount } from '../stores/react-flow';
import { useBoardPort, useBoardResult, useBoardStore, useUploadResult } from '../stores/board';
import { UploadResult } from '../../common/types';
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

		const off = window.electron.ipcRenderer.on<UploadResult>('ipc-upload-code', result => {
			if (!result.success) {
				toast.error(result.error);
				return;
			}

			setUploadResult(result.data);

			if (result.data.type === 'error') toast.error(result.data.message);
			if (result.data.type === 'close') {
				result.data.message && toast.warning(result.data.message);
				setBoardResult({ type: 'close' });
				window.electron.ipcRenderer.send('ipc-check-board', { ip: config.ip });
			}
		});

		window.electron.ipcRenderer.send('ipc-upload-code', { code, port: config.ip || port });

		return () => {
			off();
		};
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
