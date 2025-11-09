import type { MqttData, MqttValueType } from '@microflow/hardware';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from '../Handle';
import {
	BaseNode,
	NodeContainer,
	useDeleteHandles,
	useNodeControls,
	useNodeData,
	useNodeId,
} from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { useAppStore } from '../../../stores/app';
import { button } from 'leva';
import { IconWithValue } from '../IconWithValue';
import { useMqttStore } from '@microflow/mqtt-provider/client';

export function Mqtt(props: Props) {
	const { status } = useMqttStore();

	return (
		<NodeContainer {...props} error={status !== 'connected' ? 'MQTT not connected' : undefined}>
			<Subscriber />
			<Value />
			<Settings />
			{props.data.direction === 'publish' && (
				<Handle type='target' position={Position.Left} id='publish' />
			)}
			{props.data.direction === 'subscribe' && (
				<Handle type='source' position={Position.Right} id='subscribe' />
			)}
		</NodeContainer>
	);
}

function Subscriber() {
	const id = useNodeId();
	const data = useNodeData<MqttData>();
	const { subscribe } = useMqttStore();

	useEffect(() => {
		if (data.direction !== 'subscribe') return;
		if (!data.topic?.length) return;

		return subscribe(data.topic, (_topic, message) => {
			let value: unknown;
			try {
				value = JSON.parse(message.toString());
			} catch (error) {
				value = message.toString();

				const parsed = parseFloat(value as string);
				if (!isNaN(parsed)) value = parsed;
			}

			window.electron.ipcRenderer.send('ipc-external-value', {
				nodeId: id,
				value,
			});
		});
	}, [id, data.topic, data.direction, subscribe]);

	return null;
}

function Value() {
	const { publish } = useMqttStore();

	const data = useNodeData<MqttData>();
	const value = useNodeValue<MqttValueType>('');

	useEffect(() => {
		if (data.direction !== 'publish') return;
		if (!data.topic?.length) return;

		publish(data.topic, JSON.stringify(value));
	}, [value, data.topic, data.direction, publish]);

	return (
		<IconWithValue
			icon={data.direction === 'publish' ? 'RadioTower' : 'Antenna'}
			value={data.topic ?? ''}
		/>
	);
}

function Settings() {
	const { setSettingsOpen } = useAppStore();
	const deleteHandles = useDeleteHandles();

	const data = useNodeData<MqttData>();
	const { render } = useNodeControls({
		direction: {
			value: data.direction,
			options: ['publish', 'subscribe'],
			onChange: value => {
				deleteHandles(value === 'publish' ? ['subscribe'] : ['publish']);
			},
			transient: false,
		},
		topic: { value: data.topic! }, // , hint: 'mqtt/xiduzo/#'
		'broker settings': button(() => setSettingsOpen('mqtt-settings')),
	});

	return <>{render()}</>;
}

type Props = BaseNode<MqttData>;
Mqtt.defaultProps = {
	data: {
		group: 'external',
		tags: ['input', 'output'],
		label: 'MQTT',
		direction: 'publish',
		icon: 'RadioTowerIcon',
		topic: '',
		description:
			'Send or receive messages over the internet to connect with other devices and services',
	} satisfies Props['data'],
};
