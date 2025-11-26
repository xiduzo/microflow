import {
	type Data,
	type Value,
	dataSchema,
} from '@microflow/runtime/src/oscillator/oscillator.types';
import { Position } from '@xyflow/react';
import { useMemo } from 'react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { IconName } from '@microflow/ui';
import { IconWithValue } from '../IconWithValue';

export function Oscillator(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='start' offset={-1} />
			<Handle type='target' position={Position.Left} id='reset' />
			<Handle type='target' position={Position.Left} id='stop' offset={1} />
			<Handle type='source' position={Position.Right} id='change' />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<Data>();

	const icon = useMemo((): IconName => {
		switch (data.waveform) {
			case 'sinus':
				return 'AudioWaveform';
			case 'triangle':
				return 'Triangle';
			case 'sawtooth':
				return 'TriangleRight';
			case 'square':
				return 'Square';
			case 'random':
				return 'Dices';
			default:
				return 'AudioWaveform';
		}
	}, [data.waveform]);

	return <IconWithValue icon={icon} value={data.period / 1000} suffix='s' />;
}

function Settings() {
	const data = useNodeData<Data>();
	const { render } = useNodeControls({
		waveform: {
			value: data.waveform,
			options: ['sinus', 'triangle', 'sawtooth', 'square', 'random'],
		},
		period: {
			value: data.period,
			min: 100,
			step: 100,
			label: 'period (ms)',
		},
		amplitude: { value: data.amplitude, min: 0.1 },
		phase: { value: data.phase },
		shift: { value: data.shift },
		autoStart: { value: data.autoStart ?? true, label: 'auto start' },
	});

	return <>{render()}</>;
}

type Props = BaseNode<Data>;
Oscillator.defaultProps = {
	data: {
		...dataSchema.parse({}),
		group: 'flow',
		tags: ['generator', 'event'],
		label: 'Oscillator',
		icon: 'AudioWaveformIcon',
		description: 'Create repeating patterns of numbers that go up and down, like waves',
	} satisfies Props['data'],
};
