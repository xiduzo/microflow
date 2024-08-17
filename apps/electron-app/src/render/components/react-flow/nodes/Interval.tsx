import { IntervalData } from '@microflow/components';
import { Label, Slider } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useUpdateNodeData } from '../../../hooks/nodeUpdater';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
} from './Node';

const numberFormat = new Intl.NumberFormat();

export function Interval(props: Props) {
	const { updateNodeData } = useUpdateNodeData<IntervalData>(props.id);

	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="tabular-nums">
					{numberFormat.format(Math.round(props.data.value))}
				</NodeValue>
			</NodeContent>

			<NodeSettings>
				<Label
					htmlFor={`interval-${props.id}`}
					className="flex justify-between"
				>
					Interval
					<span className="opacity-40 font-light">{props.data.interval}ms</span>
				</Label>
				<Slider
					id={`interval-${props.id}`}
					className="pb-2"
					defaultValue={[props.data.interval]}
					min={500}
					max={5000}
					step={100}
					onValueChange={value => updateNodeData({ interval: value[0] })}
				/>
			</NodeSettings>
			<Handle type="source" position={Position.Left} id="start" offset={-0.5} />
			<Handle type="source" position={Position.Left} id="stop" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

type Props = BaseNode<IntervalData, number>;
export const DEFAULT_INTERVAL_DATA: Props['data'] = {
	label: 'Interval',
	interval: 500,
	value: 0,
};
