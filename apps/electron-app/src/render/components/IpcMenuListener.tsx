import { useReactFlow, type Edge, type Node } from '@xyflow/react';
import { useEffect } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { FlowFile } from '../../common/types';
import { useSaveFlow } from '../hooks/useSaveFlow';
import { useReactFlowStore } from '../stores/react-flow';
import { MqttSettingsForm } from './forms/MqttSettingsForm';
import { AdvancedSettingsForm } from './forms/AdvancedSettingsForm';
import { useAppStore } from '../stores/app';
import { useNewNodeStore } from '../stores/new-node';
import { useShallow } from 'zustand/react/shallow';

export function IpcMenuListeners() {
	const { getNodes, getEdges } = useReactFlow();
	const { setEdges, setNodes, undo, redo } = useReactFlowStore();

	const { saveNodesAndEdges, setAutoSave } = useSaveFlow();
	const [, setLocalNodes] = useLocalStorage<Node[]>('nodes', []);
	const [, setLocalEdges] = useLocalStorage<Edge[]>('edges', []);
	const setOpen = useNewNodeStore(useShallow(state => state.setOpen));
	const { settingsOpen, setSettingsOpen } = useAppStore();

	useEffect(() => {
		window.electron.ipcRenderer.on<{ button: string; args: any }>('ipc-menu', result => {
			if (!result.success) return;

			console.log(result);

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
				case 'undo':
					undo();
					break;
				case 'redo':
					redo();
					break;
				default:
					break;
			}
		});
	}, [saveNodesAndEdges, setSettingsOpen, setOpen]);

	if (settingsOpen === 'mqtt-settings') return <MqttSettingsForm open />;
	if (settingsOpen === 'board-settings') return <AdvancedSettingsForm open />;

	return null;
}
