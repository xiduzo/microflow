import { create } from 'zustand';
import mqtt, { IClientPublishOptions, OnMessageCallback } from 'mqtt';

const clients = ['app', 'plugin'] as const;
export type Client = (typeof clients)[number];

const ConnectionStatuses = ['connected', 'disconnected', 'connecting'] as const;
export type ConnectionStatus = (typeof ConnectionStatuses)[number];

export type MqttConfig = Partial<
	Pick<mqtt.IClientOptions, 'username' | 'password' | 'host' | 'port'>
> & { uniqueId: string };

type Subscription = {
	callback: OnMessageCallback;
	options?: mqtt.IClientSubscribeOptions | mqtt.IClientSubscribeProperties;
};

type MqttStore = {
	// Connection state
	status: ConnectionStatus;
	appName: Client;
	uniqueId: string;
	connectedClients: Array<{ appName: Client; status: ConnectionStatus }>;

	// Actions
	connect: (config: MqttConfig, appName: Client) => void;
	subscribe: (
		topic: string,
		callback: OnMessageCallback,
		options?: mqtt.IClientSubscribeOptions | mqtt.IClientSubscribeProperties
	) => () => void;
	publish: (topic: string, payload: string, options?: IClientPublishOptions) => void;
};

export const useMqttStore = create<MqttStore>((set, get) => {
	// Internal state (not exposed)
	let client: mqtt.MqttClient | undefined;
	let config: MqttConfig | null = null;
	let subscriptions = new Map<string, Subscription>();
	let connectedClients = new Map<Client, ConnectionStatus>();

	const disconnect = () => {
		client?.removeAllListeners();
		client?.end(true);
		client = undefined;
	};

	const unsubscribe = (topic: string) => {
		subscriptions.delete(topic);
		if (client?.connected) {
			console.debug('[MQTT] <unsubscribe>', topic);
			client.unsubscribeAsync(topic).catch(console.error);
		}
	};

	const subscribe = (
		topic: string,
		callback: OnMessageCallback,
		options?: mqtt.IClientSubscribeOptions | mqtt.IClientSubscribeProperties
	) => {
		subscriptions.set(topic, { callback, options });

		// Only subscribe if client is connected
		if (client?.connected) {
			console.debug('[MQTT] <subscribe>', client?.connected, topic, options);
			client.subscribeAsync(topic, options);
		}

		return () => {
			unsubscribe(topic);
		};
	};

	const publish = (topic: string, payload: string, options?: IClientPublishOptions) => {
		// Only publish if client is connected
		if (!client?.connected) {
			console.warn('[MQTT] <publish> Client not connected', topic);
			return;
		}

		console.debug('[MQTT] <publish>', topic, payload, options);
		client.publishAsync(topic, payload, options).catch(error => {
			console.error('[MQTT] <publish>', error);
		});
	};

	const resubscribe = async () => {
		const { appName, uniqueId } = get();
		if (!config || !appName || !uniqueId || !client?.connected) {
			return;
		}

		const statusTopic = `microflow/v1/${uniqueId}/+/status`;

		for (const [topic, { callback, options }] of Array.from(subscriptions)) {
			if (topic === statusTopic) continue;

			client.subscribeAsync(topic, options).catch(error => {
				console.error('[MQTT] <resubscribe error>', topic, error);
			});
		}
	};

	const escapeRegExp = (str: string) => {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	};

	const handleMessage = (topic: string, payload: Buffer, packet: any) => {
		Array.from(subscriptions.keys()).forEach(subscription => {
			const regexp = escapeRegExp(subscription).replace(/\\\+/g, '\\S+').replace(/\\#/, '\\S+');
			if (!topic.match(regexp)) return;

			try {
				const { callback } = subscriptions.get(subscription)!;
				callback?.(topic, payload, packet);
			} catch {
				console.error('Error in callback for topic', {
					topic,
					subscription,
				});
			}
		});
	};

	const connect = async (configParam: MqttConfig, appName: Client) => {
		config = configParam; // Update internal variables
		if (client) {
			disconnect();
			await new Promise(resolve => setTimeout(resolve, 500));
		}

		set({ status: 'connecting', appName, uniqueId: config.uniqueId });

		const defaultClient: mqtt.IClientOptions = {
			host: 'test.mosquitto.org',
			port: 8081,
		};

		console.debug('[MQTT] <connect>', config, appName);
		client = mqtt.connect({
			...defaultClient,
			protocol: 'wss',
			...config,
			will: {
				topic: `microflow/v1/${config.uniqueId}/${appName}/status`,
				retain: true,
				qos: 2,
				properties: {
					willDelayInterval: 0,
				},
				payload: new Uint8Array([
					100, 105, 115, 99, 111, 110, 110, 101, 99, 116, 101, 100,
				]) as Buffer,
			},
		});

		// Handle status messages from other clients
		const statusHandler = (topic: string, payload: Buffer) => {
			const from = topic.split('/')[3].toString();
			if (from === appName) return; // No need to get status from self

			connectedClients.set(from as Client, payload.toString() as 'connected' | 'disconnected');
			set({
				connectedClients: Array.from(connectedClients.entries()).map(([appName, status]) => ({
					appName,
					status,
				})),
			});
		};

		client
			.on('connect', async () => {
				console.debug('[MQTT] <connect>', config?.uniqueId);
				await resubscribe();
				subscribe(`microflow/v1/${config.uniqueId}/+/status`, statusHandler);
				publish(`microflow/v1/${config.uniqueId}/${appName}/status`, 'connected', {
					retain: true,
					qos: 2,
				});
				set({ status: 'connected' });
			})
			.on('reconnect', () => {
				console.debug('[MQTT] <reconnect>');
				set({ status: 'connecting' });
			})
			.on('error', error => {
				console.debug('[MQTT] <error>', error);
				set({ status: 'disconnected' });
			})
			.on('offline', () => {
				console.debug('[MQTT] <offline>');
				set({ status: 'disconnected' });
			})
			.on('disconnect', error => {
				console.debug('[MQTT] <disconnect>', error);
				set({ status: 'disconnected' });
			})
			.on('close', () => {
				console.debug('[MQTT] <close>');
				set({ status: 'disconnected' });
			})
			.on('end', () => {
				console.debug('[MQTT] <end>');
				set({ status: 'disconnected' });
			})
			.on('message', handleMessage);
	};

	return {
		// Initial state
		status: 'disconnected',
		appName: 'app',
		uniqueId: '',
		connectedClients: [],
		// Actions
		connect,
		subscribe,
		publish,
	};
});
