import type { MqttData, MqttValueType } from '@microflow/components';
import { useMqtt } from '@microflow/mqtt-provider/client';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';

export function Mqtt(props: Props) {
	const { publish, subscribe, status } = useMqtt();
	const value = useNodeValue<MqttValueType>(props.id, '');

	useEffect(() => {
		if (props.data.direction !== 'publish') return;
		if (!props.data.topic.length) return;

		publish(props.data.topic, JSON.stringify(value));
	}, [value, props.data.topic, props.data.direction, publish]);

	useEffect(() => {
		if (props.data.direction !== 'subscribe') return;
		if (!props.data.topic.length) return;

		const unsubFromTopic = subscribe(props.data.topic, (_topic, message) => {
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

			window.electron.ipcRenderer.send('ipc-external-value', props.type, props.id, value);
		});

		return () => {
			unsubFromTopic?.then(unsub => unsub?.());
		};
	}, [props.id, props.type, props.data.topic, props.data.direction, subscribe]);

	return (
		<NodeContainer {...props} error={status !== 'connected' && 'MQTT not connected'}>
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

function Value() {
	const { data } = useNode<MqttData>();

	if (data.direction === 'publish') return <Icons.RadioTower size={48} />;
	return <Icons.Antenna size={48} />;
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<MqttData>();

	useEffect(() => {
		if (!pane) return;

		pane.addBinding(settings, 'direction', {
			view: 'list',
			index: 0,
			options: [
				{ text: 'publish', value: 'publish' },
				{ text: 'subscribe', value: 'subscribe' },
			],
		});

		pane.addBinding(settings, 'topic', {
			index: 1,
		});
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<MqttData, MqttValueType>;
export const DEFAULT_MQTT_DATA: Props['data'] = {
	label: 'MQTT',
	direction: 'publish',
	topic: '',
};
