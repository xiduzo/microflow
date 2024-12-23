import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isNodeTypeACodeType } from '../../utils/generateCode';
import { useBoardPort, useBoardStore, useUploadResult } from '../stores/board';
import { UploadRequest, UploadResponse } from '../../common/types';
import { toast } from '@ui/index';
import { useClearNodeData } from '../stores/node-data';
import { useLocalStorage } from 'usehooks-ts';
import { AdvancedConfig } from '../components/forms/AdvancedSettingsForm';
import { useNewNodeStore } from '../stores/new-node';
import { useShallow } from 'zustand/react/shallow';
import { useNodeAndEdgeCount } from '../stores/react-flow';

export function useCodeUploader() {
	const clearNodeData = useClearNodeData();

	const port = useBoardPort();
	const [config] = useLocalStorage<AdvancedConfig>('advanced-config', { ip: undefined });
	const { setUploadResult } = useBoardStore();

	const { getNodes, getEdges } = useReactFlow();

	const uploadCode = useCallback(() => {
		if (!config.ip && !port) return;

		clearNodeData();
		setUploadResult({ type: 'info' });

		const nodes = getNodes().filter(node => {
			if (!isNodeTypeACodeType(node.type)) return;
			return node;
		});
		const edges = getEdges();

		// const code = generateCode(nodes, allowedEdges);
		// console.log(nodes, allowedEdges, code);
		console.debug(`[UPLOAD] >>>`, { nodes: nodes.length, edges: edges.length });
		window.electron.ipcRenderer.send<UploadRequest>('ipc-upload-code', {
			// code,
			nodes: nodes.map(node => {
				const { group, tags, label, settingsOpen, subType, ...data } = node.data;

				return {
					data,
					id: node.id,
					type: node.type,
				};
			}),
			edges: edges.map(edge => ({
				target: edge.target,
				targetHandle: edge.targetHandle,
				source: edge.source,
				sourceHandle: edge.sourceHandle,
			})),
			port: config.ip || port || '',
		});
	}, [getNodes, getEdges, port, config.ip, clearNodeData, setUploadResult]);

	return uploadCode;
}

export function useUploadResultListener() {
	const { setUploadResult, setBoardResult } = useBoardStore();

	const [config] = useLocalStorage<AdvancedConfig>('advanced-config', { ip: undefined });

	useEffect(() => {
		return window.electron.ipcRenderer.on<UploadResponse>('ipc-upload-code', result => {
			console.debug(`[UPLOAD] <<<`, result);

			if (!result.success) {
				toast.error(result.error);
				return;
			}

			setUploadResult(result.data);

			switch (result.data.type) {
				case 'close':
					toast.warning(result.data.message);
					setBoardResult({ type: 'close' });
					console.debug(`[CHECK] >>>`, { ip: config.ip });
					window.electron.ipcRenderer.send('ipc-check-board', { ip: config.ip });
					break;
				case 'error':
					toast.error(result.data.message);
					break;
			}
		});
	}, [config.ip]);
}

function useHasChangesToUpload() {
	const nodeToAdd = useNewNodeStore(useShallow(state => state.nodeToAdd));
	const uploadResult = useUploadResult();

	const [hasChangesToUpload, setHasChangesToUpload] = useState(false);

	const lastNodesCount = useRef(-1);
	const lastEdgesCount = useRef(-1);
	const { nodesCount, edgesCount } = useNodeAndEdgeCount();

	useEffect(() => {
		// We do not want to probe the user to upload code while they are adding a new node
		if (nodeToAdd?.length) return;

		// Nothing changed
		if (lastNodesCount.current === nodesCount && lastEdgesCount.current === edgesCount) return;

		const shouldUpload = lastNodesCount.current !== -1 || lastEdgesCount.current !== -1;
		lastNodesCount.current = nodesCount;
		lastEdgesCount.current = edgesCount;

		if (!shouldUpload) return;
		setHasChangesToUpload(true);
	}, [nodesCount, edgesCount, nodeToAdd]);

	useEffect(() => {
		if (uploadResult !== 'ready') return;

		// We have just uploaded the code, so we can reset the flag
		setHasChangesToUpload(false);
	}, [uploadResult]);

	return hasChangesToUpload;
}

export function useAutoUploadCode() {
	const hasChangesToUpload = useHasChangesToUpload();
	const uploadCode = useCodeUploader();

	useEffect(() => {
		if (!hasChangesToUpload) return;
		uploadCode();
	}, [hasChangesToUpload, uploadCode]);
}
