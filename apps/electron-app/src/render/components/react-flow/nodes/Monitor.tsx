import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import type { DebugValueType, MonitorData } from '@microflow/hardware';
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
function Value() {
	const data = useNodeData<MonitorData>();
	const store = useCreateStore();
	const value = useNodeValue<DebugValueType>(data.type === 'graph' ? 0 : '');

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

		return (
			<section className='text-xl tabular-nums text-muted-foreground whitespace-pre-line px-16'>
				{String(value)}
			</section>
		);
	}

	return <LevaPanel store={store} fill={true} flat titleBar={false} />;
}

function Settings() {
	const data = useNodeData<MonitorData>();
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

type Props = BaseNode<MonitorData>;
Monitor.defaultProps = {
	data: {
		group: 'flow',
		tags: ['information', 'output'],
		label: 'Monitor',
		icon: 'MonitorIcon',
		type: 'graph',
		fps: 60,
		description: 'Watch and visualize the values flowing through your circuit in real-time',
	} satisfies Props['data'],
};
