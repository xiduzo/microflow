import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { type Data, type Value, dataSchema } from '@microflow/runtime/src/monitor/monitor.types';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect, useRef } from 'react';
import { LevaPanel, monitor, useControls, useCreateStore } from 'leva';

export function Monitor(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='debug' />
		</NodeContainer>
	);
}

const numberFormat = new Intl.NumberFormat('en-US', {
	minimumFractionDigits: 0,
	maximumFractionDigits: 4,
});

function Value() {
	const data = useNodeData<Data>();
	const store = useCreateStore();
	const value = useNodeValue<Value>(data.type === 'graph' ? 0 : '');

	const ref = useRef(value);

	useControls(
		{
			' ': monitor(ref, {
				graph: data.type === 'graph',
				interval: 1000 / data.fps,
			}),
		},
		{ store },
		[data.type, data.fps]
	);
	useEffect(() => {
		ref.current = value;
	}, [value]);

	if (data.type === 'raw') {
		if (typeof value === 'string' && value.startsWith('{')) {
			return (
				<section className='text-xs text-muted-foreground text-start grow p-4 max-w-md'>
					<pre>{JSON.stringify(JSON.parse(value), null, 2)}</pre>
				</section>
			);
		}

		if (typeof value === 'number') {
			return <NumberValue value={value} />;
		}

		return <StringValue value={value} />;
	}

	return (
		<>
			<LevaPanel store={store} fill={true} flat titleBar={false} />
			<section className='absolute left-1/2 -translate-x-1/2 top-16'>
				{typeof value === 'number' ? <NumberValue value={value} /> : <StringValue value={value} />}
			</section>
		</>
	);
}

function NumberValue(props: { value: Value }) {
	return (
		<section className='text-xl tabular-nums text-muted-foreground whitespace-pre-line px-16'>
			{numberFormat.format(Number(props.value))}
		</section>
	);
}

function StringValue(props: { value: Value }) {
	return (
		<section className='text-xl tabular-nums text-muted-foreground whitespace-pre-line px-16'>
			{String(props.value)}
		</section>
	);
}

function Settings() {
	const data = useNodeData<Data>();
	const { render } = useNodeControls({
		type: { value: data.type, options: ['graph', 'raw'] },
		fps: {
			value: data.fps,
			min: 1,
			max: 240,
			step: 1,
			label: 'frames per second (FPS)',
		},
	});

	return <>{render()}</>;
}

type Props = BaseNode<Data>;
Monitor.defaultProps = {
	data: {
		...dataSchema.parse({}),
		group: 'flow',
		tags: ['information', 'output'],
		label: 'Monitor',
		icon: 'MonitorIcon',
		description: 'Watch and visualize the values flowing through your circuit in real-time',
	} satisfies Props['data'],
};
