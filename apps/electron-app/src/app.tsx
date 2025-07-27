import { FigmaProvider, MqttConfig, MqttProvider } from '@microflow/mqtt-provider/client';
import { Toaster } from '@microflow/ui';
import { ReactFlowProvider } from '@xyflow/react';
import { createRoot } from 'react-dom/client';
import { useDarkMode, useLocalStorage } from 'usehooks-ts';
import { IpcDeepLinkListener } from './render/components/IpcDeepLinkListener';
import { IpcMenuListeners } from './render/components/IpcMenuListener';
import { ReactFlowCanvas } from './render/components/react-flow/ReactFlowCanvas';
import { useSignalNodesAndEdges } from './render/hooks/useSignalNodesAndEdges';
import { useCelebrateFirstUpload, useCheckBoard } from './render/hooks/useBoard';
import { CelebrationProvider } from './render/providers/CelebrationProvider';
import { NewNodeCommandDialog } from './render/providers/NewNodeProvider';
import { useAutoUploadCode, useUploadResultListener } from './render/hooks/useCodeUploader';
import { StrictMode, useEffect } from 'react';
import { useAppStore } from './render/stores/app';
import { getRandomUniqueUserName } from './common/unique';

export function App() {
	const { user } = useAppStore();

	const [mqttConfig, setMqttConfig] = useLocalStorage<MqttConfig>('mqtt-config', {
		uniqueId: user?.name ?? getRandomUniqueUserName(),
	});

	useEffect(() => {
		if (!user?.name) return;
		setMqttConfig({ ...mqttConfig, uniqueId: user.name });
	}, [user, setMqttConfig]);

	return (
		<section className='h-screen w-screen'>
			<DarkMode />
			<Toaster position='top-left' className='z-20' duration={5000} />
			<CelebrationProvider>
				<MqttProvider appName='app' config={mqttConfig}>
					<FigmaProvider>
						<ReactFlowProvider>
							<IpcDeepLinkListener />
							<NewNodeCommandDialog />
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
root.render(
	<StrictMode>
		<App />
	</StrictMode>
);

function BoardHooks() {
	useSignalNodesAndEdges();
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
