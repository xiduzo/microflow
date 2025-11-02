import { FigmaVariable, useFigmaStore, useMqttStore } from '@microflow/mqtt-provider/client';
import { Toaster } from '@microflow/ui';
import { ReactFlowProvider } from '@xyflow/react';
import { createRoot } from 'react-dom/client';
import { useDarkMode } from 'usehooks-ts';
import { IpcDeepLinkListener } from './render/components/IpcDeepLinkListener';
import { IpcMenuListeners } from './render/components/IpcMenuListener';
import { ReactFlowCanvas } from './render/components/react-flow/ReactFlowCanvas';
import { useSignalNodesAndEdges } from './render/hooks/useSignalNodesAndEdges';
import { useCelebrateFirstUpload, useFlowSync } from './render/hooks/useFlowSync';
import { CelebrationParticles } from './render/components/CelebrationParticles';
import { NewNodeCommandDialog } from './render/providers/NewNodeProvider';
import { StrictMode, useEffect, useMemo } from 'react';
import { useAppStore } from './render/stores/app';
import { MqttSettingsForm } from './render/components/forms/MqttSettingsForm';
import { AdvancedSettingsForm } from './render/components/forms/AdvancedSettingsForm';
import { UserSettingsForm } from './render/components/forms/UserSettingsForm';

export function App() {
	return (
		<section className='h-screen w-screen'>
			<DarkMode />
			<MQTT />
			<Figma />
			<Settings />
			<Toaster position='top-left' className='z-20' duration={5000} />
			<CelebrationParticles />
			<ReactFlowProvider>
				<IpcDeepLinkListener />
				<NewNodeCommandDialog />
				<ReactFlowCanvas />
				<IpcMenuListeners />
				<BoardHooks />
			</ReactFlowProvider>
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
	useFlowSync();

	return null;
}

function MQTT() {
	const { connect } = useMqttStore();
	const { user } = useAppStore();

	useEffect(() => {
		if (!user?.name) return;
		return connect({ uniqueId: user.name }, 'app');
	}, [connect, user?.name]);

	return null;
}

function Figma() {
	const { publish, subscribe, status, uniqueId, appName, connectedClients } = useMqttStore();
	const { updateVariableTypes, updateVariableValue } = useFigmaStore();

	const pluginConnected = useMemo(
		() => connectedClients.find(({ appName }) => appName === 'plugin')?.status === 'connected',
		[connectedClients]
	);

	useEffect(() => {
		return subscribe(`microflow/v1/${uniqueId}/plugin/variables`, (topic, message) => {
			console.log('[Figma] variables', topic, message.toString());
			updateVariableTypes(JSON.parse(message.toString()) as Record<string, FigmaVariable>);
		});
	}, [subscribe, uniqueId, updateVariableTypes]);

	useEffect(() => {
		return subscribe(`microflow/v1/${uniqueId}/plugin/variable/+`, (topic, message) => {
			console.log('[Figma] variable', topic, message.toString(), topic.split('/')[5]);
			updateVariableValue(topic.split('/')[5], JSON.parse(message.toString()));
		});
	}, [subscribe, uniqueId, updateVariableValue]);

	useEffect(() => {
		return subscribe(`microflow/v1/${uniqueId}/${appName}/variables/response`, (topic, message) => {
			console.log('[Figma] variables/response', topic, message.toString());
			updateVariableTypes(JSON.parse(message.toString()) as Record<string, FigmaVariable>);
		});
	}, [subscribe, uniqueId, appName, updateVariableTypes]);

	useEffect(() => {
		if (status !== 'connected' || !pluginConnected) return;
		if (!pluginConnected) return;
		publish(`microflow/v1/${uniqueId}/${appName}/variables/request`, '');
	}, [status, publish, pluginConnected, uniqueId, appName]);

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

function Settings() {
	const { settingsOpen } = useAppStore();

	return (
		<>
			<MqttSettingsForm open={settingsOpen === 'mqtt-settings'} />
			<AdvancedSettingsForm open={settingsOpen === 'board-settings'} />
			<UserSettingsForm open={settingsOpen === 'user-settings'} />
		</>
	);
}
