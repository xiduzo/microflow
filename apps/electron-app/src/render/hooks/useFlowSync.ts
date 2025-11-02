import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { Board, FlowState } from '../../common/types';
import { useCelebration } from '../stores/celebration';
import { useBoardPort, useBoardStore, useBoard } from '../stores/board';
import { AdvancedConfig } from '../components/forms/AdvancedSettingsForm';
import { toast } from '@microflow/ui';
import { useReactFlow } from '@xyflow/react';
import { useNodeAndEdgeCount } from '../stores/react-flow';
import { useShallow } from 'zustand/shallow';
import { useNewNodeStore } from '../stores/new-node';
import { isNodeTypeACodeType } from '../../utils/generateCode';
import { useClearNodeData } from '../stores/node-data';

export function useCelebrateFirstUpload() {
	const [isFirstUpload, setIsFirstUpload] = useLocalStorage('isFirstUpload', true);
	const celebrate = useCelebration();

	const board = useBoard();

	useEffect(() => {
		if (!isFirstUpload) return;
		if (board?.type !== 'ready') return;

		celebrate('Succesfully connected your first microcontroller, happy hacking!');
		setIsFirstUpload(false);
	}, [board?.type, isFirstUpload]);
}

let lastUploadHash: string | null = null;
export function useFlowSync() {
	const board = useBoard();
	const { setBoard } = useBoardStore();
	const { getNodes, getEdges } = useReactFlow();
	const clearNodeData = useClearNodeData();

	const nodeToAdd = useNewNodeStore(useShallow(({ nodeToAdd }) => nodeToAdd));

	const [config] = useLocalStorage<AdvancedConfig>('advanced-config', {
		ip: undefined,
	});

	const { nodesCount, edgesCount } = useNodeAndEdgeCount();
	const lastNodesCount = useRef(nodesCount);
	const lastEdgesCount = useRef(edgesCount);

	const flowChanged = useCallback(() => {
		const nodes = getNodes();
		const edges = getEdges();

		lastEdgesCount.current = edges.length;
		lastNodesCount.current = nodes.length;

		const nodesToSend = nodes.filter(node => isNodeTypeACodeType(node));

		const nodeData = nodesToSend.map(node => {
			const { group, tags, label, settingsOpen, subType, ...data } = node.data;
			return { data, id: node.id, type: node.type };
		});

		const edgeData = edges.map(edge => ({
			target: edge.target,
			targetHandle: edge.targetHandle,
			source: edge.source,
			sourceHandle: edge.sourceHandle,
		}));

		const stateHash = JSON.stringify({ nodes: nodeData, edges: edgeData });
		if (lastUploadHash === stateHash) return;
		lastUploadHash = stateHash;

		clearNodeData();

		window.electron.ipcRenderer.send<FlowState & { ip?: string }>('ipc-flow', {
			nodes: nodesToSend,
			edges,
			ip: config.ip,
		});
	}, [getNodes, getEdges, config.ip, clearNodeData]);

	useEffect(() => {
		if (board.type !== 'ready') return;

		if (nodeToAdd) return;

		if (nodesCount === lastNodesCount.current && edgesCount === lastEdgesCount.current) return;

		flowChanged();
	}, [nodeToAdd, flowChanged, nodesCount, edgesCount]);

	useEffect(() => {
		return window.electron.ipcRenderer.on<Board>('ipc-board', result => {
			console.debug(`[FLOW] <<<< <ipc-board>`, result);

			if (!result.success) {
				setBoard({ type: 'error', message: result.error });
				return;
			}

			switch (result.data.type) {
				case 'close':
					lastUploadHash = null;
					break;
				case 'ready':
					// toast.info(result.data.message);
					break;
				case 'connect':
					flowChanged();
					break;
				case 'warn':
					toast.warning(result.data.message);
					break;
				case 'info':
					toast.info(result.data.message);
					break;
			}

			setBoard(result.data);
		});
	}, [getNodes, getEdges, setBoard]);

	return { flowChanged };
}
