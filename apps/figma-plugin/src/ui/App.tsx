import { MqttProvider } from '@microflow/mqtt-provider/client';
import '@microflow/ui/global.css';
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

const router = createMemoryRouter([
	{ path: '/', Component: Home },
	{ path: '/mqtt', Component: Mqtt },
	{ path: '/variables', Component: Variables },
]);

export function App() {
	const [brokerSettings, setBrokerSettings] = useLocalStorage<{ uniqueId: string } | null>(
		LOCAL_STORAGE_KEYS.MQTT_CONNECTION,
		{ initialValue: null },
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
		},
	);

	if (brokerSettings === null) return null;

	return (
		<section className="dark">
			<MqttProvider appName="plugin" config={brokerSettings}>
				<MqttVariableMessenger />
				<RouterProvider router={router} />
			</MqttProvider>
		</section>
	);
}
