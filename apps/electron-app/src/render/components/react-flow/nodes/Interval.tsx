import type { IntervalData, IntervalValueType } from '@microflow/components';
import { Label, Slider } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
	useNodeSettings,
} from './Node';

const numberFormat = new Intl.NumberFormat();

export function Interval(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="tabular-nums">
					{numberFormat.format(Math.round(props.data.value))}
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<IntervalSettings />
			</NodeSettings>
			<Handle type="target" position={Position.Left} id="start" offset={-0.5} />
			<Handle type="target" position={Position.Left} id="stop" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function IntervalSettings() {
	const { settings, setSettings } = useNodeSettings<IntervalData>();

	return (
		<>
			<Label htmlFor="interval" className="flex justify-between">
				Interval
				<span className="opacity-40 font-light">{settings.interval}ms</span>
			</Label>
			<Slider
				id="interval"
				className="pb-2"
				defaultValue={[settings.interval]}
				min={500}
				max={5000}
				step={100}
				onValueChange={value => setSettings({ interval: value[0] })}
			/>
		</>
	);
}

type Props = BaseNode<IntervalData, IntervalValueType>;
export const DEFAULT_INTERVAL_DATA: Props['data'] = {
	label: 'Interval',
	interval: 500,
	value: 0,
};
