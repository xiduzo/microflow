import { useContext, useEffect, useRef, useState } from 'react';

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
	const disconnectedIntervals = useRef<Map<Client, NodeJS.Timeout>>(new Map());

	useEffect(() => {
		return connect(props.config);
	}, [connect, props.config]);

	useEffect(() => {
		Object.keys(subscriptions.current).forEach(topic => {
			unsubscribe(topic);
		});
		setConnectedClients(new Map());
		publish(`microflow/v1/${props.config.uniqueId}/${props.appName}/ping`, '');
	}, [props.config.uniqueId, props.appName, unsubscribe]);

	useEffect(() => {
		if (status !== 'connected') return;

		const unsubFromPing = subscribe(`microflow/v1/${props.config.uniqueId}/+/ping`, topic => {
			const from = topic.split('/')[3].toString();
			if (from === props.appName) return; // No need to pong to self
			// if we received a ping it is connected
			setConnectedClients(prev => {
				prev.set(from as Client, 'connected');
				return new Map(prev);
			});
			publish(`microflow/v1/${props.config.uniqueId}/${from}/pong`, props.appName);
		});

		const unsubFromPong = subscribe(
			`microflow/v1/${props.config.uniqueId}/${props.appName}/pong`,
			(topic, message) => {
				setConnectedClients(prev => {
					const client = message.toString() as Client;
					prev.set(client, 'connected');
					const interval = disconnectedIntervals.current.get(client);
					if (interval) {
						clearTimeout(interval);
					}
					return new Map(prev);
				});
			},
		);

		publish(`microflow/v1/${props.config.uniqueId}/${props.appName}/ping`, '');
		const interval = setInterval(async () => {
			setConnectedClients(prev => {
				prev.forEach((_status, client) => {
					const prevStatus = prev.get(client);
					prev.set(client, prevStatus === 'disconnected' ? 'disconnected' : 'connecting');
					disconnectedIntervals.current.set(
						client,
						setTimeout(() => {
							setConnectedClients(prev => {
								prev.set(client, 'disconnected');
								return new Map(prev);
							});
						}, 1000 * 5),
					);
				});
				return new Map(prev);
			});
			await publish(`microflow/v1/${props.config.uniqueId}/${props.appName}/ping`, '');
		}, 1000 * 15);

		return () => {
			clearInterval(interval);
			unsubFromPing?.then(unsub => unsub?.());
			unsubFromPong?.then(unsub => unsub?.());
		};
	}, [status, subscribe, publish, props.appName, props.config.uniqueId]);

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
