import type { IntervalData, IntervalValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { useNodeValue } from '../../../stores/node-data';

const numberFormat = new Intl.NumberFormat();

export function Interval(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="start" offset={-0.5} />
			<Handle type="target" position={Position.Left} id="stop" offset={0.5} />
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<IntervalData>();
	const value = useNodeValue<IntervalValueType>(0);

	return (
		<section className="flex flex-col text-center gap-1 items-center text-muted-foreground">
			<div className="tabular-nums">{numberFormat.format(Math.round(value))}</div>
			<div className="text-xs tabular-nums">each {numberFormat.format(data.interval / 1000)}s</div>
		</section>
	);
}

function Settings() {
	const data = useNodeData<IntervalData>();
	const { render } = useNodeControls({
		interval: { value: data.interval, min: 100, step: 100 },
	});

	return <>{render()}</>;
}

type Props = BaseNode<IntervalData>;
Interval.defaultProps = {
	data: {
		group: 'flow',
		tags: ['event'],
		label: 'Interval',
		interval: 500,
		description: 'Emit a signal at a regular interval',
	} satisfies Props['data'],
};
