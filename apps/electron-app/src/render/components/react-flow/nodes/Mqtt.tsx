import type { MqttData, MqttDirection, MqttValueType } from '@microflow/components';
import { useMqtt } from '@microflow/mqtt-provider/client';
import {
	Badge,
	Icons,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from '@microflow/ui';
import { Position, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
	useNodeSettings,
} from './Node';

export function Mqtt(props: Props) {
	const updateNodeInternals = useUpdateNodeInternals();

	const { publish, subscribe, status } = useMqtt();

	useEffect(() => {
		if (props.data.direction !== 'publish') return;
		if (!props.data.topic.length) return;

		publish(props.data.topic, JSON.stringify(props.data.value));
	}, [props.data.value, props.data.topic, props.data.direction, publish]);

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
		<NodeContainer {...props}>
			<NodeContent>
				{status !== 'connected' && <Badge variant="destructive">MQTT not connected</Badge>}
				<NodeValue className="tabular-nums">
					{props.data.direction === 'publish' ? (
						<Icons.RadioTower className="w-8 h-8" />
					) : (
						<Icons.Antenna className="w-8 h-8" />
					)}
				</NodeValue>
			</NodeContent>
			<NodeSettings
				onClose={() => {
					updateNodeInternals(props.id);
				}}
			>
				<MqttSettings />
			</NodeSettings>
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

function MqttSettings() {
	const { settings, setSettings } = useNodeSettings<MqttData>();
	return (
		<>
			<Select
				value={settings.direction}
				onValueChange={(value: MqttDirection) => {
					setSettings({ direction: value });
				}}
			>
				<SelectTrigger>{settings.direction}</SelectTrigger>
				<SelectContent>
					<SelectItem value="publish">Publish</SelectItem>
					<SelectItem value="subscribe">Subscribe</SelectItem>
				</SelectContent>
			</Select>
			<Label htmlFor="topic" className="flex justify-between">
				Topic
			</Label>
			<Input
				id="topic"
				defaultValue={settings.topic}
				placeholder="your/+/topic/#"
				onChange={event =>
					setSettings({
						topic: event.target.value,
					})
				}
			/>
		</>
	);
}

type Props = BaseNode<MqttData, MqttValueType>;
export const DEFAULT_MQTT_DATA: Props['data'] = {
	label: 'MQTT',
	direction: 'publish',
	value: '',
	topic: '',
};
