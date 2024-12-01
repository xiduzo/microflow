import { useContext, useEffect, useState } from 'react';

import mqtt, { Packet } from 'mqtt/*';
import { createContext, PropsWithChildren } from 'react';
import { ConnectionStatus, useMqttClient } from '../hooks/useMqttClient';

const clients = ['app', 'plugin'] as const;
export type Client = (typeof clients)[number];

type UseMqttClientProps = ReturnType<typeof useMqttClient>;
type MqttProviderContextProps = {
	connectedClients: Map<Client, ConnectionStatus>;
	appName: Client;
	uniqueId: string;
};

const MqttProviderContext = createContext<UseMqttClientProps & MqttProviderContextProps>({
	status: 'disconnected',
	connectedClients: new Map<Client, ConnectionStatus>(),
	connect: () => () => {},
	disconnect: () => {},
	subscribe: () => Promise.resolve(() => {}),
	unsubscribe: () => Promise.resolve() as any as Promise<Packet>,
	publish: () => Promise.resolve() as any as Promise<Packet>,
	subscriptions: {
		current: new Map(),
	},
	appName: 'app',
	uniqueId: '',
} as UseMqttClientProps & MqttProviderContextProps);

export function MqttProvider(props: PropsWithChildren & Props) {
	const mqttClient = useMqttClient();
	const { connect, status, subscribe, publish, subscriptions, unsubscribe } = mqttClient;
	const [connectedClients, setConnectedClients] = useState<Map<Client, ConnectionStatus>>(
		new Map(),
	);

	useEffect(() => {
		return connect({ ...props.config, appName: props.appName });
	}, [connect, props.config, props.appName]);

	useEffect(() => {
		Object.keys(subscriptions.current).forEach(topic => {
			unsubscribe(topic);
		});
		setConnectedClients(new Map());
	}, [props.config.uniqueId, props.appName, unsubscribe]);

	useEffect(() => {
		if (status !== 'connected') return;

		const unsubFromStatus = subscribe(
			`microflow/v1/${props.config.uniqueId}/+/status`,
			(topic, message) => {
				const from = topic.split('/')[3].toString();
				if (from === props.appName) return; // No need to get status from self
				console.debug('received status from', { from, message, topic });
				// if we received a ping it is connected
				setConnectedClients(prev => {
					prev.set(from as Client, message.toString() as 'connected' | 'disconnected');
					return new Map(prev);
				});
			},
			{
				qos: 1,
				rap: true,
				rh: 1,
			},
		);

		return () => {
			unsubFromStatus?.then(unsub => unsub?.());
		};
	}, [status, subscribe, props.appName, props.config.uniqueId]);

	return (
		<MqttProviderContext.Provider
			value={{
				...mqttClient,
				connectedClients,
				appName: props.appName,
				uniqueId: props.config.uniqueId,
			}}
		>
			{props.children}
		</MqttProviderContext.Provider>
	);
}

export type MqttConfig = Partial<
	Pick<mqtt.IClientOptions, 'username' | 'password' | 'host' | 'port'>
> & { uniqueId: string };
type Props = {
	appName: Client;
	config: MqttConfig;
};

export const useMqtt = () => useContext(MqttProviderContext);
