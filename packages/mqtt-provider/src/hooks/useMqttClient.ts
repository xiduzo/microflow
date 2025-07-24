import mqtt, { IClientPublishOptions } from 'mqtt';
import { useCallback, useRef, useState } from 'react';

const ConnectionStatusus = ['connected', 'disconnected', 'connecting'] as const;
export type ConnectionStatus = (typeof ConnectionStatusus)[number];

export function useMqttClient() {
	const client = useRef<mqtt.MqttClient>();

	const [status, setStatus] = useState<ConnectionStatus>('disconnected');
	const subscriptions = useRef(
		new Map<
			string,
			{
				callback: mqtt.OnMessageCallback;
				options?: mqtt.IClientSubscribeOptions | mqtt.IClientSubscribeProperties;
			}
		>(),
	);

	const disconnect = useCallback(() => {
		setStatus('disconnected');
		client.current?.end();
		client.current = undefined;
	}, []);

	const unsubscribe = useCallback((topic: string) => {
		subscriptions.current.delete(topic);
		return client.current?.unsubscribeAsync(topic);
	}, []);

	const subscribe = useCallback(
		async (
			topic: string,
			callback: mqtt.OnMessageCallback,
			options?: mqtt.IClientSubscribeOptions | mqtt.IClientSubscribeProperties,
		) => {
			console.debug('[MQTT] <subscribe>', topic, options);
			subscriptions.current.set(topic, { callback, options });
			await client.current
				?.subscribeAsync(topic, options) // TODO these options should be passed by subscriber
				.catch(console.error);

			return () => {
				console.debug('[MQTT] <unsubscribe>', topic, options);
				unsubscribe?.(topic)?.catch(console.error);
			};
		},
		[unsubscribe],
	);

	const publish = useCallback((topic: string, payload: string, options?: IClientPublishOptions) => {
		console.debug('[MQTT] <publish>', topic, payload, options);
		return client.current?.publishAsync(topic, payload, options);
	}, []);

	const resubscribe = useCallback(
		async (options: { uniqueId: string; appName: string }) => {
			for (const [topic, { callback, options }] of Array.from(subscriptions.current)) {
				try {
					await subscribe(topic, callback, options);
				} catch (e) {
					console.error(e);
				}
			}
			setStatus('connected');
			await publish(`microflow/v1/${options.uniqueId}/${options.appName}/status`, 'connected', {
				retain: true,
				qos: 1,
			});
		},
		[unsubscribe, subscribe],
	);

	const connect = useCallback(
		(options: mqtt.IClientOptions & { uniqueId: string; appName: string }) => {
			const defaultClient: mqtt.IClientOptions = {
				host: 'test.mosquitto.org',
				port: 8081,
			};

			if (client.current) return;

			client.current = mqtt.connect({
				...defaultClient,
				protocol: 'wss',
				...options,
				will: {
					topic: `microflow/v1/${options.uniqueId}/${options.appName}/status`,
					retain: true,
					qos: 2,
					properties: {
						willDelayInterval: 0,
					},
					// const encoder = new TextEncoder();
					// encoder.encode('disconnected');
					payload: new Uint8Array([
						100, 105, 115, 99, 111, 110, 110, 101, 99, 116, 101, 100,
					]) as Buffer,
				},
			});

			client.current
				.on('connect', async () => {
					console.debug('connect', options.uniqueId);
					await resubscribe(options);
				})
				.on('reconnect', async () => {
					console.debug('[MQTT] <reconnect>');
					setStatus('connecting');
					await resubscribe(options);
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
					setStatus('connecting');
					await resubscribe(options);
				})
				.on('message', (topic, payload, packet) => {
					console.debug('[MQTT] <message>', topic, payload);
					Array.from(subscriptions.current.keys()).forEach(subscription => {
						const regexp = new RegExp(
							subscription.replace(/\//g, '\\/').replace(/\+/g, '\\S+').replace(/#/, '\\S+'),
						);
						if (!topic.match(regexp)) return;

						try {
							const { callback } = subscriptions.current.get(subscription);
							callback?.(topic, payload, packet);
						} catch {
							console.error('Error in callback for topic', {
								topic,
								subscription,
							});
						}
					});
				});

			return () => {
				disconnect();
			};
		},
		[resubscribe, disconnect],
	);

	return {
		status,
		connect,
		disconnect,
		subscribe,
		unsubscribe,
		publish,
		subscriptions,
	};
}
