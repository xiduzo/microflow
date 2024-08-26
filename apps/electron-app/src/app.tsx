import { FigmaProvider, MqttConfig, MqttProvider } from '@microflow/mqtt-provider/client';
import { Toaster } from '@microflow/ui';
import { initParticlesEngine } from '@tsparticles/react';
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadFull } from 'tsparticles';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { useLocalStorage } from 'usehooks-ts';
import { MqttSettingsForm } from './render/components/forms/MqttSettingsForm';
import { ReactFlowCanvas } from './render/components/react-flow/ReactFlowCanvas';
import { useSaveFlow } from './render/hooks/useSaveFlow';
import { useSignalNodesAndEdges } from './render/hooks/useSignalNodesAndEdges';
import { BoardProvider } from './render/providers/BoardProvider';
import { CelebrationProvider } from './render/providers/CelebrationProvider';
import { NewNodeProvider, useNewNode } from './render/providers/NewNodeProvider';

export function App() {
	const [init, setInit] = useState(false);

	const [mqttConfig, setMqttConfig] = useLocalStorage<MqttConfig | undefined>('mqtt-config', {
		uniqueId: '',
	});

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

	useEffect(() => {
		initParticlesEngine(async engine => {
			await loadFull(engine);
		}).then(() => {
			setInit(true);
		});
	}, []);

	return (
		<CelebrationProvider init={init}>
			<Toaster position="top-right" className="z-20" />
			<BoardProvider>
				<MqttProvider appName="app" config={mqttConfig}>
					<FigmaProvider>
						<ReactFlowProvider>
							<NodeAndEdgeSignaler />
							<NewNodeProvider>
								<ReactFlowCanvas />
								<IpcMenuListeners />
							</NewNodeProvider>
						</ReactFlowProvider>
					</FigmaProvider>
				</MqttProvider>
			</BoardProvider>
		</CelebrationProvider>
	);
}

const root = createRoot(document.body.querySelector('main'));
root.render(<App />);

function IpcMenuListeners() {
	const { saveNodesAndEdges, clearNodesAndEdges, setAutoSave } = useSaveFlow();
	const { setOpen } = useNewNode();
	const [showMqttSettings, setShowMqttSettings] = useState(false);

	useEffect(() => {
		window.electron.ipcRenderer.on('ipc-menu', (button: string, ...props: unknown[]) => {
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
		});
	}, [saveNodesAndEdges, setOpen]);

	if (showMqttSettings) return <MqttSettingsForm open onClose={() => setShowMqttSettings(false)} />;

	return null;
}

function NodeAndEdgeSignaler() {
	useSignalNodesAndEdges();

	return null;
}
