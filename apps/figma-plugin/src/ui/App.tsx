import { MqttProvider } from '@microflow/mqtt-provider/client';
import '@microflow/ui/globals.css';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { LOCAL_STORAGE_KEYS, MESSAGE_TYPE } from '../common/types/Message';
import { MqttVariableMessenger } from './components/MqttVariableMessenger';
import { useLocalStorage } from './hooks/useLocalStorage';
import './index.css';
import { Home } from './pages/home';
import { Mqtt } from './pages/mqtt';
import { Variables } from './pages/variables';
import { useMessageListener } from './hooks/useMessageListener';
import { useEffect } from 'react';

const router = createMemoryRouter([
	{ path: '/', Component: Home },
	{ path: '/mqtt', Component: Mqtt },
	{ path: '/variables', Component: Variables },
]);

export function App() {
	const [brokerSettings, setBrokerSettings] = useLocalStorage<{ uniqueId: string } | null>(
		LOCAL_STORAGE_KEYS.MQTT_CONNECTION,
		{ initialValue: null }
	);

	// Due the the async nature of Figma's local-storage,
	// we initially set the value to `null` and listen to the response.
	// If the response is still null we can set a default value.
	useMessageListener<{ key: LOCAL_STORAGE_KEYS; value?: any }>(
		MESSAGE_TYPE.GET_LOCAL_STATE_VALUE,
		payload => {
			if (payload?.key !== LOCAL_STORAGE_KEYS.MQTT_CONNECTION) return;
			if (payload?.value !== null) return;

			setBrokerSettings({
				uniqueId: uniqueNamesGenerator({ dictionaries: [adjectives, animals] }),
			});
		}
	);

	if (brokerSettings === null) return null;

	return (
		<>
			<DarkMode />
			<MqttProvider appName='plugin' config={brokerSettings}>
				<MqttVariableMessenger />
				<RouterProvider router={router} />
			</MqttProvider>
		</>
	);
}

function DarkMode() {
	const [, setIsDarkMode] = useLocalStorage<boolean>(LOCAL_STORAGE_KEYS.DARK_MODE, {
		initialValue: false,
	});

	useEffect(() => {
		const likesDarkMode = window.matchMedia('(prefers-color-scheme: dark)');
		toggleDarkMode(likesDarkMode.matches);

		function toggleDarkMode(darkMode: boolean) {
			setIsDarkMode(darkMode);

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
	}, []);

	return null;
}
