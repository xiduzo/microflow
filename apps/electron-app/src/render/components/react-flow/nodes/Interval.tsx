import { type Data, type Value, dataSchema } from '@microflow/runtime/src/interval/interval.types';
import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { MIN_INTERVAL_IN_MS } from '@microflow/runtime/src/interval/interval.constants';

const numberFormat = new Intl.NumberFormat();

export function Interval(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='start' offset={-0.5} />
			<Handle type='target' position={Position.Left} id='stop' offset={0.5} />
			<Handle type='source' position={Position.Right} id='change' />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<Data>();
	const value = useNodeValue<Value>(0);

	return (
		<section className='flex flex-col text-center gap-1 items-center text-muted-foreground'>
			<div className='tabular-nums'>{numberFormat.format(Math.round(value))}</div>
			<div className='text-xs tabular-nums'>each {numberFormat.format(data.interval / 1000)}s</div>
		</section>
	);
}

function Settings() {
	const data = useNodeData<Data>();
	const { render } = useNodeControls({
		interval: { value: data.interval, min: MIN_INTERVAL_IN_MS, step: 100, label: 'interval (ms)' },
	});

	return <>{render()}</>;
}

type Props = BaseNode<Data>;
Interval.defaultProps = {
	data: {
		...dataSchema.parse({}),
		group: 'flow',
		tags: ['event', 'generator'],
		label: 'Interval',
		icon: 'TimerIcon',
		description: 'Automatically send a signal at regular time intervals, like a timer',
	} satisfies Props['data'],
};
