import { FigmaProvider, MqttConfig, MqttProvider } from '@microflow/mqtt-provider/client';
import { Toaster } from '@microflow/ui';
import { initParticlesEngine } from '@tsparticles/react';
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadFull } from 'tsparticles';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { useLocalStorage } from 'usehooks-ts';
import { IpcDeepLinkListener } from './render/components/IpcDeepLinkListener';
import { IpcMenuListeners } from './render/components/IpcMenuListener';
import { ReactFlowCanvas } from './render/components/react-flow/ReactFlowCanvas';
import { useSignalNodesAndEdges } from './render/hooks/useSignalNodesAndEdges';
import { useCelebrateFirstUpload, useCheckBoard } from './render/hooks/useBoard';
import { CelebrationProvider } from './render/providers/CelebrationProvider';
import { NewNodeProvider } from './render/providers/NewNodeProvider';

export function App() {
	useCelebrateFirstUpload();
	useCheckBoard();

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
			<Toaster position="top-left" className="z-20" />
			<IpcDeepLinkListener />
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
		</CelebrationProvider>
	);
}

const root = createRoot(document.body.querySelector('main'));
root.render(<App />);

function NodeAndEdgeSignaler() {
	useSignalNodesAndEdges();

	return null;
}
