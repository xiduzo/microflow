import type { MqttData, MqttValueType } from '@microflow/components';
import { useMqtt } from '@microflow/mqtt-provider/client';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeId, useNodeSettings } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { useAppStore } from '../../../stores/app';

export function Mqtt(props: Props) {
	const { status } = useMqtt();

	return (
		<NodeContainer {...props} error={status !== 'connected' ? 'MQTT not connected' : undefined}>
			<Subscriber />
			<Value />
			<Settings />
			{props.data.direction === 'publish' && (
				<Handle type="target" position={Position.Left} id="publish" />
			)}
			{props.data.direction === 'subscribe' && (
				<Handle type="source" position={Position.Right} id="subscribe" />
			)}
		</NodeContainer>
	);
}

function Subscriber() {
	const id = useNodeId();
	const data = useNodeData<MqttData>();
	const { subscribe } = useMqtt();

	useEffect(() => {
		if (data.direction !== 'subscribe') return;
		if (!data.topic?.length) return;

		const unsubFromTopic = subscribe(data.topic, (_topic, message) => {
			let value: unknown;
			try {
				value = JSON.parse(message.toString());
			} catch (error) {
				value = message.toString();

				const parsed = parseFloat(value as string);
				if (!isNaN(parsed)) value = parsed;
			}

			window.electron.ipcRenderer.send('ipc-external-value', { nodeId: id, value });
		});

		return () => {
			unsubFromTopic?.then(unsub => unsub?.());
		};
	}, [id, data.topic, data.direction, subscribe]);

	return null;
}

function Value() {
	const { publish } = useMqtt();

	const data = useNodeData<MqttData>();
	const value = useNodeValue<MqttValueType>('');

	useEffect(() => {
		if (data.direction !== 'publish') return;
		if (!data.topic?.length) return;

		publish(data.topic, JSON.stringify(value));
	}, [value, data.topic, data.direction, publish]);

	if (data.direction === 'publish') return <Icons.RadioTower size={48} />;
	return <Icons.Antenna size={48} />;
}

function Settings() {
	const { pane, settings, setHandlesToDelete } = useNodeSettings<MqttData>();
	const { settingsOpen, setSettingsOpen } = useAppStore();

	useEffect(() => {
		if (!pane) return;

		const initialType = settings.direction;

		const direction = pane
			.addBinding(settings, 'direction', {
				view: 'list',
				index: 0,
				options: [
					{ text: 'publish', value: 'publish' },
					{ text: 'subscribe', value: 'subscribe' },
				],
			})
			.on('change', ({ value }) => {
				if (value === initialType) setHandlesToDelete([]);
				else setHandlesToDelete(value === 'publish' ? ['subscribe'] : ['publish']);
			});

		const topic = pane.addBinding(settings, 'topic', {
			index: 1,
		});

		const button = pane.addButton({
			title: 'Broker settings',
			index: 2,
		});

		button.on('click', () => {
			setSettingsOpen('mqtt-settings');
		});

		return () => {
			direction.dispose();
			topic.dispose();
			button.dispose();
		};
	}, [pane, settings, setHandlesToDelete]);

	return null;
}

type Props = BaseNode<MqttData>;
Mqtt.defaultProps = {
	data: {
		group: 'external',
		tags: ['input', 'output'],
		label: 'MQTT',
		direction: 'publish',
		topic: '',
		description: 'Publish or subscribe to MQTT topics',
	} satisfies Props['data'],
};
