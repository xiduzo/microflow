import { useReactFlow, type Edge, type Node } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { FlowFile } from '../../common/types';
import { useSaveFlow } from '../hooks/useSaveFlow';
import {
	useDeselectAll,
	useReactFlowStore,
	useSelectAll,
	useSelectedEdges,
	useSelectNodes,
} from '../stores/react-flow';
import { MqttSettingsForm } from './forms/MqttSettingsForm';
import { AdvancedSettingsForm } from './forms/AdvancedSettingsForm';
import { useAppStore } from '../stores/app';
import { useNewNodeStore } from '../stores/new-node';
import { useShallow } from 'zustand/react/shallow';

export function IpcMenuListeners() {
	const { getNodes, getEdges, fitView } = useReactFlow();
	const { setEdges, setNodes, undo, redo, onNodesChange, onEdgesChange } = useReactFlowStore();

	const { saveNodesAndEdges, setAutoSave } = useSaveFlow();
	const [, setLocalNodes] = useLocalStorage<Node[]>('nodes', []);
	const [, setLocalEdges] = useLocalStorage<Edge[]>('edges', []);
	const setOpen = useNewNodeStore(useShallow(state => state.setOpen));
	const { settingsOpen, setSettingsOpen } = useAppStore();
	const [copiedNodes, setCopiedNodes] = useState<Node[]>([]);
	const selectAll = useSelectAll();
	const deselectAll = useDeselectAll();
	const selectedNodes = useSelectNodes();
	const selectedEdges = useSelectedEdges();

	function canTriggerAction() {
		const selectedElement = window.document.activeElement as HTMLElement;

		if (selectedElement === window.document.body) return true;
		if (selectedElement.classList.contains('react-flow__node')) return true;
		if (selectedElement.classList.contains('react-flow__edge')) return true;
		if (selectedElement.classList.contains('react-flow__nodesselection-rect')) return true;

		return false;
	}

	useEffect(() => {
		return window.electron.ipcRenderer.on<{ button: string; args: any }>('ipc-menu', result => {
			if (!result.success) return;

			switch (result.data.button) {
				case 'save-flow':
					saveNodesAndEdges();
					break;
				case 'new-flow':
					setLocalEdges([]);
					setLocalNodes([]);
					setNodes([]);
					setEdges([]);
					break;
				case 'add-node':
					setOpen(true);
					break;
				case 'toggle-autosave':
					setAutoSave(Boolean(result.data.args));
					break;
				case 'mqtt-settings':
				case 'board-settings':
					setSettingsOpen(result.data.button);
					break;
				case 'export-flow':
					window.electron.ipcRenderer.send('ipc-export-flow', {
						nodes: getNodes(),
						edges: getEdges(),
					});
					break;
				case 'import-flow':
					// TODO: data validation
					const { nodes, edges } = result.data.args as FlowFile;
					setNodes(nodes);
					setEdges(edges);
					break;
				case 'fit-flow':
					fitView({
						duration: 400,
						padding: 0.15,
						nodes: selectedNodes().length > 0 ? selectedNodes() : undefined,
					});
					break;
				case 'undo':
					if (!canTriggerAction()) break;
					undo();
					break;
				case 'redo':
					if (!canTriggerAction()) break;
					redo();
					break;
				case 'select-all':
					if (!canTriggerAction()) break;
					selectAll();
					break;
				case 'deselect-all':
					if (!canTriggerAction()) break;
					deselectAll();
					break;
				case 'copy':
					if (!canTriggerAction()) break;
					setCopiedNodes(selectedNodes());
					break;
				case 'cut':
					if (!canTriggerAction()) break;
					setCopiedNodes(selectedNodes());
					onNodesChange(
						selectedNodes().map(node => ({
							type: 'remove',
							id: node.id,
						})),
					);
					break;
				case 'paste':
					if (!canTriggerAction()) break;
					deselectAll();
					onNodesChange(
						copiedNodes.map(node => ({
							type: 'add',
							item: {
								...node,
								id: Math.random().toString(36).substring(2, 8),
								position: {
									x: node.position.x + 20,
									y: node.position.y + 20,
								},
								selected: true,
								dragging: true,
							},
						})),
					);
					break;
				case 'delete':
					if (!canTriggerAction()) break;
					onNodesChange(
						selectedNodes().map(node => ({
							type: 'remove',
							id: node.id,
						})),
					);
					onEdgesChange(
						selectedEdges().map(edge => ({
							type: 'remove',
							id: edge.id,
						})),
					);
					break;
				default:
					break;
			}
		});
	}, [
		saveNodesAndEdges,
		setSettingsOpen,
		setOpen,
		undo,
		redo,
		selectAll,
		deselectAll,
		selectedNodes,
		onNodesChange,
		selectedEdges,
		onEdgesChange,
		copiedNodes,
	]);

	if (settingsOpen === 'mqtt-settings') return <MqttSettingsForm open />;
	if (settingsOpen === 'board-settings') return <AdvancedSettingsForm open />;

	return null;
}
