import { useReactFlow, type Edge, type Node } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { FlowFile } from '../../common/types';
import { useSaveFlow } from '../hooks/useSaveFlow';
import { useNewNode } from '../providers/NewNodeProvider';
import { useNodesEdgesStore } from '../stores/react-flow';
import { MqttSettingsForm } from './forms/MqttSettingsForm';

export function IpcMenuListeners() {
	const { getNodes, getEdges } = useReactFlow();
	const { setEdges, setNodes, undo, redo } = useNodesEdgesStore();

	const { saveNodesAndEdges, setAutoSave } = useSaveFlow();
	const [, setLocalNodes] = useLocalStorage<Node[]>('nodes', []);
	const [, setLocalEdges] = useLocalStorage<Edge[]>('edges', []);
	const { setOpen } = useNewNode();
	const [showMqttSettings, setShowMqttSettings] = useState(false);

	useEffect(() => {
		window.electron.ipcRenderer.on('ipc-menu', (button: string, ...props: unknown[]) => {
			switch (button) {
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
					setAutoSave(Boolean(props[0]));
					break;
				case 'mqtt-settings':
					setShowMqttSettings(true);
					break;
				case 'export-flow':
					window.electron.ipcRenderer.send('ipc-export-flow', getNodes(), getEdges());
					break;
				case 'import-flow':
					// TODO: data validation
					const { nodes, edges } = props[0] as FlowFile;
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
	}, [saveNodesAndEdges, setOpen]);

	if (showMqttSettings) return <MqttSettingsForm open onClose={() => setShowMqttSettings(false)} />;

	return null;
}
