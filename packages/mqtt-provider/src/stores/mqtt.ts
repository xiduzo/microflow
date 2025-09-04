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
	connect: (config: MqttConfig, appName: Client) => () => void;
	subscribe: (
		topic: string,
		callback: OnMessageCallback,
		options?: mqtt.IClientSubscribeOptions | mqtt.IClientSubscribeProperties
	) => () => void;
	publish: (
		topic: string,
		payload: string,
		options?: IClientPublishOptions
	) => Promise<mqtt.Packet | undefined>;
};

export const useMqttStore = create<MqttStore>((set, get) => {
	// Internal state (not exposed)
	let client: mqtt.MqttClient | undefined;
	let config: MqttConfig | null = null;
	let subscriptions = new Map<string, Subscription>();
	let connectedClients = new Map<Client, ConnectionStatus>();

	const disconnect = () => {
		set({ status: 'disconnected' });
		client?.end();
		client = undefined;
	};

	const unsubscribe = (topic: string) => {
		subscriptions.delete(topic);
		return () => {
			client?.unsubscribeAsync(topic);
		};
	};

	const subscribe = (
		topic: string,
		callback: OnMessageCallback,
		options?: mqtt.IClientSubscribeOptions | mqtt.IClientSubscribeProperties
	) => {
		console.debug('[MQTT] <subscribe>', topic, options);

		subscriptions.set(topic, { callback, options });

		client?.subscribeAsync(topic, options).catch(console.error);

		return () => {
			console.debug('[MQTT] <unsubscribe>', topic, options);
			unsubscribe(topic);
		};
	};

	const publish = (topic: string, payload: string, options?: IClientPublishOptions) => {
		console.debug('[MQTT] <publish>', topic, payload, options);
		return client?.publishAsync(topic, payload, options) ?? Promise.resolve(undefined);
	};

	const resubscribe = async () => {
		const { appName, uniqueId } = get();
		if (!config || !appName || !uniqueId) return;

		for (const [topic, { callback, options }] of Array.from(subscriptions)) {
			try {
				subscribe(topic, callback, options);
			} catch (e) {
				console.error(e);
			}
		}

		set({ status: 'connected' });

		await publish(`microflow/v1/${uniqueId}/${appName}/status`, 'connected', {
			retain: true,
			qos: 1,
		});
	};

	const escapeRegExp = (str: string) => {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	};

	const handleMessage = (topic: string, payload: Buffer, packet: any) => {
		console.debug('[MQTT] <message>', topic, payload);

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

	const connect = (configParam: MqttConfig, appName: Client) => {
		if (client) return () => {};

		// Update internal variables
		config = configParam;
		set({ appName, uniqueId: config.uniqueId });

		const defaultClient: mqtt.IClientOptions = {
			host: 'test.mosquitto.org',
			port: 8081,
		};

		const mqttClient = mqtt.connect({
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

		client = mqttClient;

		mqttClient
			.on('connect', async () => {
				console.debug('[MQTT] <connect>', config.uniqueId);
				await resubscribe();
			})
			.on('reconnect', async () => {
				console.debug('[MQTT] <reconnect>');
				set({ status: 'connecting' });
				await resubscribe();
			})
			.on('error', error => {
				console.debug('[MQTT] <error>', error);
				disconnect();
			})
			.on('disconnect', error => {
				console.debug('[MQTT] <disconnect>', error);
				disconnect();
			})
			.on('close', async () => {
				console.debug('[MQTT] <close>');
				set({ status: 'connecting' });
				await resubscribe();
			})
			.on('message', handleMessage);

		// Subscribe to status updates from other clients
		mqttClient
			.subscribeAsync(`microflow/v1/${config.uniqueId}/+/status`, {
				qos: 1,
				rap: true,
				rh: 1,
			})
			.then(() => {
				// Handle status messages
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

				// Add status handler to subscriptions
				subscriptions.set(`microflow/v1/${config.uniqueId}/+/status`, { callback: statusHandler });
			});

		return () => {
			disconnect();
		};
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
