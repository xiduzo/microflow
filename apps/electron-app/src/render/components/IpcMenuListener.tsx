import { useReactFlow, type Edge, type Node } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { FlowState } from '../../common/types';
import {
	useDeselectAll,
	useNonInternalNodes,
	useReactFlowStore,
	useSelectAll,
	useSelectedEdges,
	useSelectedNodes,
} from '../stores/react-flow';
import { useCollaborationActions } from '../stores/yjs';
import { MqttSettingsForm } from './forms/MqttSettingsForm';
import { AdvancedSettingsForm } from './forms/AdvancedSettingsForm';
import { useAppStore } from '../stores/app';
import { useNewNodeStore } from '../stores/new-node';
import { useShallow } from 'zustand/shallow';
import { uid } from '../../common/uuid';

function canTriggerAction() {
	const selectedElement = window.document.activeElement as HTMLElement;

	if (selectedElement === window.document.body) return true;
	if (selectedElement.classList.contains('react-flow__node')) return true;
	if (selectedElement.classList.contains('react-flow__edge')) return true;
	if (selectedElement.classList.contains('react-flow__nodesselection-rect')) return true;

	return false;
}

export function IpcMenuListeners() {
	const { getNodes, getEdges, fitView } = useReactFlow();
	const { setEdges, setNodes, onNodesChange, onEdgesChange } = useReactFlowStore();
	const { undo, redo } = useCollaborationActions();

	const setOpen = useNewNodeStore(useShallow(state => state.setOpen));
	const { settingsOpen, setSettingsOpen } = useAppStore();
	const [copiedNodes, setCopiedNodes] = useState<Node[]>([]);
	const selectAll = useSelectAll();
	const deselectAll = useDeselectAll();
	const selectedNodes = useSelectedNodes();
	const selectedEdges = useSelectedEdges();
	const nonInternalNodes = useNonInternalNodes();

	useEffect(() => {
		return window.electron.ipcRenderer.on<{ button: string; args: any }>('ipc-menu', result => {
			if (!result.success) return;

			switch (result.data.button) {
				case 'new-flow':
					setNodes([]);
					setEdges([]);
					break;
				case 'add-node':
					setOpen(true);
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
					// IDEA data validation
					const { nodes, edges } = result.data.args as FlowState;
					setNodes(nodes);
					setEdges(edges);
					break;
				case 'fit-flow':
					fitView({
						duration: 400,
						padding: 0.15,
						nodes:
							selectedNodes().length > 0
								? selectedNodes()
								: nonInternalNodes().length > 0
									? nonInternalNodes()
									: undefined,
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
					window.getSelection()?.removeAllRanges();
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
						}))
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
								id: uid(),
								position: {
									// IDEA center of mouse on canvas
									x: node.position.x + 20,
									y: node.position.y + 20,
								},
							},
						}))
					);
					break;
				case 'delete':
					if (!canTriggerAction()) break;
					onNodesChange(
						selectedNodes().map(node => ({
							type: 'remove',
							id: node.id,
						}))
					);
					onEdgesChange(
						selectedEdges().map(edge => ({
							type: 'remove',
							id: edge.id,
						}))
					);
					break;
				default:
					break;
			}
		});
	}, [
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

	return null;
}
