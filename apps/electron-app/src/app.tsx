import { FigmaProvider, MqttConfig, MqttProvider } from '@fhb/mqtt/client';
import { Toaster } from '@fhb/ui';
import { Edge, Node, ReactFlowProvider } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
	adjectives,
	animals,
	uniqueNamesGenerator,
} from 'unique-names-generator';
import { useLocalStorage } from 'usehooks-ts';
import { MqttSettingsForm } from './render/components/forms/MqttSettingsForm';
import { ReactFlowCanvas } from './render/components/react-flow/ReactFlowCanvas';
import { useSaveFlow } from './render/hooks/useSaveFlow';
import { useSignalNodesAndEdges } from './render/hooks/useSignalNodesAndEdges';
import { BoardProvider } from './render/providers/BoardProvider';
import {
	NewNodeProvider,
	useNewNode,
} from './render/providers/NewNodeProvider';
import { useNodesEdgesStore } from './render/store';

export function App() {
	const [mqttConfig, setMqttConfig] = useLocalStorage<MqttConfig | undefined>(
		'mqtt-config',
		{
			uniqueId: '',
		},
	);

	// Somehow initial triggers engless rerenders
	// This is a workaround
	useEffect(() => {
		if (mqttConfig.uniqueId.length) {
			return;
		}

		setMqttConfig({
			uniqueId: uniqueNamesGenerator({ dictionaries: [adjectives, animals] }),
		});
	}, [mqttConfig.uniqueId]);

	return (
		<MqttProvider appName="app" config={mqttConfig}>
			<FigmaProvider>
				<BoardProvider>
					<ReactFlowProvider>
						<NodeAndEdgeSignaler />
						<LoadNodesAndEdges />
						<NewNodeProvider>
							<ReactFlowCanvas />
							<IpcMenuListeners />
						</NewNodeProvider>
					</ReactFlowProvider>
				</BoardProvider>
			</FigmaProvider>
			<Toaster position="top-right" />
		</MqttProvider>
	);
}

const root = createRoot(document.body.querySelector('main'));
root.render(<App />);

function IpcMenuListeners() {
	const { saveNodesAndEdges, clearNodesAndEdges, setAutoSave } = useSaveFlow();
	const { setOpen } = useNewNode();
	const [showMqttSettings, setShowMqttSettings] = useState(false);

	useEffect(() => {
		window.electron.ipcRenderer.on(
			'ipc-menu',
			(button: string, ...props: unknown[]) => {
				console.log('ipc-menu', button, props);

				switch (button) {
					case 'save-flow':
						saveNodesAndEdges();
						break;
					case 'clear-flow':
						clearNodesAndEdges();
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
					default:
						break;
				}
			},
		);
	}, [saveNodesAndEdges, setOpen]);

	if (showMqttSettings)
		return <MqttSettingsForm open onClose={() => setShowMqttSettings(false)} />;

	return null;
}

function NodeAndEdgeSignaler() {
	useSignalNodesAndEdges();

	return null;
}

function LoadNodesAndEdges() {
	const [localNodes] = useLocalStorage<Node[]>('nodes', []);
	const [localEdges] = useLocalStorage<Edge[]>('edges', []);
	const { setNodes, setEdges } = useNodesEdgesStore();

	useEffect(() => {
		setNodes(localNodes);
		setEdges(localEdges);
	}, [setNodes, localNodes, setEdges, localEdges]);

	return null;
}
