import { useMqttStore } from '@microflow/mqtt-provider/client';
import '@microflow/ui/globals.css';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { MqttVariableMessenger } from './components/MqttVariableMessenger';
import './index.css';
import { Home } from './pages/home';
import { Mqtt } from './pages/mqtt';
import { Variables } from './pages/variables';
import { useEffect } from 'react';
import { APP_STATE_LOCAL_STORAGE_KEY, AppState, useAppStore } from './stores/app';
import { useMessageListener } from './hooks/useMessageListener';
import { MESSAGE_TYPE } from '../common/types/Message';

const router = createMemoryRouter([
	{ path: '/', Component: Home },
	{ path: '/mqtt', Component: Mqtt },
	{ path: '/variables', Component: Variables },
]);

export function App() {
	return (
		<>
			<InitApp />
			<DarkMode />
			<MQTT />
			<MqttVariableMessenger />
			<RouterProvider router={router} />
		</>
	);
}

function MQTT() {
	const { connect } = useMqttStore();
	const { mqttConfig } = useAppStore();

	useEffect(() => {
		if (!mqttConfig) return;

		connect(mqttConfig, 'plugin');
	}, [connect, mqttConfig]);

	return null;
}

function InitApp() {
	const { setAppState } = useAppStore();
	useMessageListener<{ key: string; value?: string }>(
		MESSAGE_TYPE.GET_LOCAL_STATE_VALUE,
		payload => {
			if (payload?.key !== APP_STATE_LOCAL_STORAGE_KEY) return;
			if (!payload.value) return;
			const parsed = JSON.parse(payload.value) as Record<string, unknown>;
			if ('state' in parsed) {
				setAppState(parsed.state as Partial<AppState>);
			}
		}
	);
	return null;
}

function DarkMode() {
	const { setDarkMode } = useAppStore();

	useEffect(() => {
		const likesDarkMode = window.matchMedia('(prefers-color-scheme: dark)');
		toggleDarkMode(likesDarkMode.matches);

		function toggleDarkMode(darkMode: boolean) {
			setDarkMode(darkMode);

			if (darkMode) {
				window.document.body.classList.add('dark');
			} else {
				window.document.body.classList.remove('dark');
			}
		}

		function handleEvent(event: MediaQueryListEvent) {
			toggleDarkMode(event.matches);
		}

		likesDarkMode.addEventListener('change', handleEvent);

		return () => {
			likesDarkMode.removeEventListener('change', handleEvent);
		};
	}, [setDarkMode]);

	return null;
}
