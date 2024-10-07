import { FigmaProvider, MqttConfig, MqttProvider } from '@microflow/mqtt-provider/client';
import { toast, Toaster } from '@microflow/ui';
import { initParticlesEngine } from '@tsparticles/react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadFull } from 'tsparticles';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { useLocalStorage } from 'usehooks-ts';
import { useShallow } from 'zustand/react/shallow';
import { FlowFile } from './common/types';
import { MqttSettingsForm } from './render/components/forms/MqttSettingsForm';
import { ReactFlowCanvas } from './render/components/react-flow/ReactFlowCanvas';
import { useSaveFlow } from './render/hooks/useSaveFlow';
import { useSignalNodesAndEdges } from './render/hooks/useSignalNodesAndEdges';
import { BoardProvider } from './render/providers/BoardProvider';
import { CelebrationProvider } from './render/providers/CelebrationProvider';
import { NewNodeProvider, useNewNode } from './render/providers/NewNodeProvider';
import { setNodesAndEdgesSelecor, useNodesEdgesStore } from './render/store';

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
			<IpcDeepLinkListener />
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
  const { getNodes, getEdges } = useReactFlow();
  const { setEdges, setNodes } = useNodesEdgesStore(useShallow(setNodesAndEdgesSelecor));

	const { saveNodesAndEdges, clearNodesAndEdges, setAutoSave } = useSaveFlow();
	const { setOpen } = useNewNode();
	const [showMqttSettings, setShowMqttSettings] = useState(false);

	useEffect(() => {
		window.electron.ipcRenderer.on('ipc-menu', (button: string, ...props: unknown[]) => {
			switch (button) {
				case 'save-flow':
					saveNodesAndEdges();
					break;
				case 'new-flow':
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
				case 'export-flow':
				  window.electron.ipcRenderer.send('ipc-export-flow', getNodes(), getEdges());
          break;
        case 'import-flow':
          // TODO: data validation
          const { nodes, edges } = props[0] as FlowFile
          setNodes(nodes)
          setEdges(edges)
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

function IpcDeepLinkListener() {
	useEffect(() => {
		return window.electron.ipcRenderer.on('ipc-deep-link', (event, ...args) => {
			console.log('ipc-deep-link', event, args);

			switch (event) {
				case 'web':
					toast.success('Microflow studio successfully linked!');
					break;
				default:
					break;
			}
		});
	}, []);

	return null;
}
