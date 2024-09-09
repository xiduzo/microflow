import { MqttProvider } from '@microflow/mqtt-provider/client';
import '@microflow/ui/global.css';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { LOCAL_STORAGE_KEYS } from '../common/types/Message';
import { MqttVariableMessenger } from './components/MqttVariableMessenger';
import { useLocalStorage } from './hooks/useLocalStorage';
import './index.css';
import { Home } from './pages/home';
import { Mqtt } from './pages/mqtt';
import { Variables } from './pages/variables';

const router = createMemoryRouter([
	{ path: '/', Component: Home },
	{ path: '/mqtt', Component: Mqtt },
	{ path: '/variables', Component: Variables },
]);

export function App() {
	const [brokerSettings] = useLocalStorage(LOCAL_STORAGE_KEYS.MQTT_CONNECTION, {
		initialValue: {
			uniqueId: uniqueNamesGenerator({ dictionaries: [adjectives, animals] }),
		},
	});

	return (
		<section className="dark">
			<MqttProvider appName="plugin" config={brokerSettings}>
				<MqttVariableMessenger />
				<RouterProvider router={router} />
			</MqttProvider>
		</section>
	);
}
