import type { IntervalData, IntervalValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
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
	const { addBinding } = useNodeSettings<IntervalData>();

	useEffect(() => {
		addBinding('interval', { index: 0, min: 100, max: 5000, step: 100 });
	}, [addBinding]);

	return null;
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
