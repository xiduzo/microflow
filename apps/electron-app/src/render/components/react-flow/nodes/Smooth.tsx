import type { MovingAverage, SmoothAverage, SmoothData } from '@microflow/components';
import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { IconWithValue } from '../IconWithValue';

export function Smooth(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="signal" />
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<SmoothData>();

	return (
		<IconWithValue
			icon={data.type === 'movingAverage' ? 'Highlighter' : 'Eraser'}
			value={data.type === 'movingAverage' ? data.windowSize : data.attenuation}
		/>
	);
}

function Settings() {
	const data = useNodeData<SmoothData>();

	const { render } = useNodeControls({
		type: { value: data.type, options: { smooth: 'smooth', movingAverage: 'moving average' } },
		windowSize: {
			value: (data as MovingAverage).windowSize ?? 25,
			min: 1,
			step: 1,
			render: get => get('type') === 'movingAverage',
		},
		attenuation: {
			value: (data as SmoothAverage).attenuation ?? 0.995,
			min: 0.0,
			max: 1.0,
			step: 0.001,
			render: get => get('type') === 'movingAverage',
		},
	});

	return <>{render()}</>;
}

type Props = BaseNode<SmoothData>;
Smooth.defaultProps = {
	data: {
		group: 'flow',
		tags: ['transformation'],
		label: 'Smooth',
		type: 'smooth',
		attenuation: 0.995,
		description: 'Smooth incoming signals to reduce noise',
	} satisfies Props['data'],
};
