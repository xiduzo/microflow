import {
	type Data,
	MovingAverage,
	SmoothAverage,
	type Value,
	dataSchema,
} from '@microflow/runtime/src/smooth/smooth.types';
import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { IconWithValue } from '../IconWithValue';

export function Smooth(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='signal' />
			<Handle type='source' position={Position.Right} id='change' />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<Data>();

	return (
		<IconWithValue
			icon={data.type === 'movingAverage' ? 'Highlighter' : 'Eraser'}
			value={data.type === 'movingAverage' ? data.windowSize : data.attenuation}
		/>
	);
}

function Settings() {
	const data = useNodeData<Data>();

	const { render } = useNodeControls({
		type: {
			value: data.type,
			options: { smooth: 'smooth', 'moving average': 'movingAverage' },
		},
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
			render: get => get('type') === 'smooth',
		},
	});

	return <>{render()}</>;
}

type Props = BaseNode<Data>;
Smooth.defaultProps = {
	data: {
		...dataSchema.parse({ type: 'smooth' }),
		group: 'flow',
		tags: ['transformation'],
		label: 'Smooth',
		icon: 'EraserIcon',
		description: 'Make jumpy or noisy sensor readings smoother and more stable',
	} satisfies Props['data'],
};
