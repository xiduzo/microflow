import { FigmaProvider, MqttConfig, MqttProvider } from '@microflow/mqtt-provider/client';
import { Toaster } from '@microflow/ui';
import { ReactFlowProvider } from '@xyflow/react';
import { createRoot } from 'react-dom/client';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { useLocalStorage } from 'usehooks-ts';
import { IpcDeepLinkListener } from './render/components/IpcDeepLinkListener';
import { IpcMenuListeners } from './render/components/IpcMenuListener';
import { ReactFlowCanvas } from './render/components/react-flow/ReactFlowCanvas';
import { useSignalNodesAndEdges } from './render/hooks/useSignalNodesAndEdges';
import { useCelebrateFirstUpload, useCheckBoard } from './render/hooks/useBoard';
import { CelebrationProvider } from './render/providers/CelebrationProvider';
import { NewNodeCommandDialog } from './render/providers/NewNodeProvider';
import { useEffect } from 'react';

export function App() {
	const [mqttConfig] = useLocalStorage<MqttConfig>('mqtt-config', {
		uniqueId: uniqueNamesGenerator({ dictionaries: [adjectives, animals] }),
	});

	useEffect(() => {
		const log = (event: KeyboardEvent) => console.log(event);

		window.addEventListener('keydown', log);

		return () => {
			window.removeEventListener('keydown', log);
		};
	}, []);

	return (
		<>
			<CelebrationProvider>
				<Toaster position="top-left" className="z-20" />
				<IpcDeepLinkListener />
				<MqttProvider appName="app" config={mqttConfig}>
					<FigmaProvider>
						<ReactFlowProvider>
							<NewNodeCommandDialog />
							<NodeAndEdgeSignaler />
							<ReactFlowCanvas />
							<IpcMenuListeners />
						</ReactFlowProvider>
					</FigmaProvider>
				</MqttProvider>
			</CelebrationProvider>
			<BoardHooks />
		</>
	);
}

const root = createRoot(document.body.querySelector('main')!);
root.render(<App />);

function NodeAndEdgeSignaler() {
	useSignalNodesAndEdges();

	return null;
}

function BoardHooks() {
	useCelebrateFirstUpload();
	useCheckBoard();

	return null;
}
