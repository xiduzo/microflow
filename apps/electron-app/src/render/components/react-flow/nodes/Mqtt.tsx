import type { MqttData, MqttValueType } from '@microflow/components';
import { useMqtt } from '@microflow/mqtt-provider/client';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';

export function Mqtt(props: Props) {
	const { status } = useMqtt();

	return (
		<NodeContainer {...props} error={status !== 'connected' && 'MQTT not connected'}>
			<Subscriber />
			<Value />
			<Settings />
			{props.data.direction === 'publish' && (
				<Handle type="target" position={Position.Left} id="publish" />
			)}
			{props.data.direction === 'subscribe' && (
				<Handle type="source" position={Position.Right} id="subscribe" />
			)}
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Subscriber() {
	const { data, id } = useNode<MqttData>();
	const { subscribe } = useMqtt();

	useEffect(() => {
		if (data.direction !== 'subscribe') return;
		if (!data.topic.length) return;

		const unsubFromTopic = subscribe(data.topic, (_topic, message) => {
			let value: unknown;
			try {
				value = JSON.parse(message.toString());
			} catch (error) {
				value = message.toString();

				const parsed = parseFloat(value as string);
				if (!isNaN(parsed)) {
					value = parsed;
				}
			}

			window.electron.ipcRenderer.send('ipc-external-value', id, value);
		});

		return () => {
			unsubFromTopic?.then(unsub => unsub?.());
		};
	}, [id, data.topic, data.direction, subscribe]);

	return null;
}

function Value() {
	const { publish } = useMqtt();

	const { data, id } = useNode<MqttData>();
	const value = useNodeValue<MqttValueType>(id, '');

	useEffect(() => {
		if (data.direction !== 'publish') return;
		if (!data.topic.length) return;

		publish(data.topic, JSON.stringify(value));
	}, [value, data.topic, data.direction, publish]);

	if (data.direction === 'publish') return <Icons.RadioTower size={48} />;
	return <Icons.Antenna size={48} />;
}

function Settings() {
	const { pane, settings, setHandlesToDelete } = useNodeSettingsPane<MqttData>();

	useEffect(() => {
		if (!pane) return;

		const initialDirection = settings.direction;

		pane
			.addBinding(settings, 'direction', {
				view: 'list',
				index: 0,
				options: [
					{ text: 'publish', value: 'publish' },
					{ text: 'subscribe', value: 'subscribe' },
				],
			})
			.on('change', event => {
				if (event.value === initialDirection) setHandlesToDelete([]);
				else setHandlesToDelete(event.value === 'publish' ? ['subscribe'] : ['publish']);
			});

		pane.addBinding(settings, 'topic', {
			index: 1,
		});
	}, [pane, settings, setHandlesToDelete]);

	return null;
}

type Props = BaseNode<MqttData, MqttValueType>;
export const DEFAULT_MQTT_DATA: Props['data'] = {
	label: 'MQTT',
	direction: 'publish',
	topic: '',
};
