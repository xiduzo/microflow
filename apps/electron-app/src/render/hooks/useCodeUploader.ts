import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isNodeTypeACodeType } from '../../utils/generateCode';
import { useBoardCheckResult, useBoardPort, useBoardStore } from '../stores/board';
import { UploadRequest, UploadResponse } from '../../common/types';
import { toast } from '@microflow/ui';
import { useClearNodeData } from '../stores/node-data';
import { useLocalStorage } from 'usehooks-ts';
import { AdvancedConfig } from '../components/forms/AdvancedSettingsForm';
import { useNewNodeStore } from '../stores/new-node';
import { useShallow } from 'zustand/shallow';
import { useNodeAndEdgeCount } from '../stores/react-flow';
import { toBase64 } from '@microflow/utils/base64';

// Global upload state to prevent redundant uploads
let lastUploadHash = '';

export function useCodeUploader() {
	const clearNodeData = useClearNodeData();
	const port = useBoardPort();
	const [config] = useLocalStorage<AdvancedConfig>('advanced-config', {
		ip: undefined,
	});
	const { setUploadResult, board } = useBoardStore();
	const { getNodes, getEdges } = useReactFlow();

	const uploadCode = useCallback(() => {
		if (!config.ip && !port) return;
		if (board.type !== 'ready') return;

		// Create a hash of the current state to detect actual changes
		const nodes = getNodes().filter(node => {
			if (!isNodeTypeACodeType(node)) return false;
			return node;
		});
		const edges = getEdges();

		const nodesToSend = nodes.map(node => {
			const { group, tags, label, settingsOpen, subType, ...data } = node.data;
			return {
				data,
				id: node.id,
				type: node.type,
			};
		});
		const edgesToSend = edges.map(edge => ({
			target: edge.target,
			targetHandle: edge.targetHandle,
			source: edge.source,
			sourceHandle: edge.sourceHandle,
		}));

		const stateHash = JSON.stringify({ nodes: nodesToSend, edges: edgesToSend });

		console.debug('[UPLOAD]', stateHash);

		// Skip if the state hasn't actually changed
		if (lastUploadHash === stateHash) {
			console.debug('[UPLOAD] Skipping - no state change');
			return;
		}

		lastUploadHash = stateHash;
		clearNodeData();

		setUploadResult({ type: 'info' });

		console.debug(`[UPLOAD] >>>>`, stateHash);

		window.electron.ipcRenderer.send<UploadRequest>('ipc-upload-code', {
			nodes: nodesToSend,
			edges: edgesToSend,
			port: config.ip || port || '',
		});
	}, [getNodes, getEdges, board.type, port, config.ip, clearNodeData, setUploadResult]);

	return uploadCode;
}

export function useUploadResultListener() {
	const { setUploadResult, setBoardResult } = useBoardStore();
	const [config] = useLocalStorage<AdvancedConfig>('advanced-config', {
		ip: undefined,
	});

	useEffect(() => {
		return window.electron.ipcRenderer.on<UploadResponse>('ipc-upload-code', result => {
			console.debug(`[UPLOAD] <<<< <ipc-upload-code>`, result);

			if (!result.success) {
				toast.error(result.error);
				return;
			}

			setUploadResult(result.data);

			switch (result.data.type) {
				case 'close':
					toast.warning(result.data.message);
					setBoardResult({ type: 'close' });
					console.debug(`[CHECK] >>>>`, { ip: config.ip });
					window.electron.ipcRenderer.send('ipc-check-board', {
						ip: config.ip,
					});
					break;
				case 'error':
					toast.error(result.data.message);
					break;
			}
		});
	}, [config.ip]);
}

export function useAutoUploadCode() {
	const nodeToAdd = useNewNodeStore(useShallow(state => state.nodeToAdd));
	const checkResult = useBoardCheckResult();
	const uploadCode = useCodeUploader();

	const lastNodesCount = useRef(-1);
	const lastEdgesCount = useRef(-1);
	const { nodesCount, edgesCount } = useNodeAndEdgeCount();

	useEffect(() => {
		if (checkResult !== 'ready') {
			lastNodesCount.current = -1;
			lastEdgesCount.current = -1;
			return;
		}

		// We do not want to upload code while they are adding a new node
		if (nodeToAdd?.length) return;

		// Nothing changed
		if (lastNodesCount.current === nodesCount && lastEdgesCount.current === edgesCount) return;

		lastNodesCount.current = nodesCount;
		lastEdgesCount.current = edgesCount;

		console.debug(`[UPLOAD] <useAutoUploadCode> - node/edge count change`);
		uploadCode();
	}, [nodesCount, edgesCount, nodeToAdd, uploadCode, checkResult]);
}
