import { FigmaProvider, MqttConfig, MqttProvider } from '@microflow/mqtt-provider/client';
import { Toaster } from '@microflow/ui';
import { ReactFlowProvider } from '@xyflow/react';
import { createRoot } from 'react-dom/client';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { useDarkMode, useLocalStorage } from 'usehooks-ts';
import { IpcDeepLinkListener } from './render/components/IpcDeepLinkListener';
import { IpcMenuListeners } from './render/components/IpcMenuListener';
import { ReactFlowCanvas } from './render/components/react-flow/ReactFlowCanvas';
import { useSignalNodesAndEdges } from './render/hooks/useSignalNodesAndEdges';
import { useCelebrateFirstUpload, useCheckBoard } from './render/hooks/useBoard';
import { CelebrationProvider } from './render/providers/CelebrationProvider';
import { NewNodeCommandDialog } from './render/providers/NewNodeProvider';
import { useAutoUploadCode, useUploadResultListener } from './render/hooks/useCodeUploader';
import { useEffect } from 'react';
import { io } from '@microflow/websocket/client';

export function App() {
	const [mqttConfig] = useLocalStorage<MqttConfig>('mqtt-config', {
		uniqueId: uniqueNamesGenerator({ dictionaries: [adjectives, animals] }),
	});

	useEffect(() => {
		const socket = io('ws://localhost:8888');
		socket.on('connect', () => {
			console.log('[SOCKET] connected');
		});
		socket.emit('howdy', 'partner');
	}, []);

	return (
		<section className="h-screen w-screen">
			<DarkMode />
			<Toaster position="top-left" className="z-20" duration={5000} />
			<CelebrationProvider>
				<IpcDeepLinkListener />
				<MqttProvider appName="app" config={mqttConfig}>
					<FigmaProvider>
						<ReactFlowProvider>
							<NewNodeCommandDialog />
							<NodeAndEdgeSignaler />
							<ReactFlowCanvas />
							<IpcMenuListeners />
							<BoardHooks />
						</ReactFlowProvider>
					</FigmaProvider>
				</MqttProvider>
			</CelebrationProvider>
		</section>
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
	useAutoUploadCode();
	useUploadResultListener();

	return null;
}

function DarkMode() {
	const { isDarkMode } = useDarkMode();
	useEffect(() => {
		if (isDarkMode) {
			document.body.classList.add('dark');
		} else {
			document.body.classList.remove('dark');
		}
	}, [isDarkMode]);

	return null;
}
