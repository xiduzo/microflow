import type { OscillatorData } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { IconName } from '@ui/index';
import { IconWithValue } from '../IconWithValue';

export function Oscillator(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="start" offset={-1} />
			<Handle type="target" position={Position.Left} id="reset" />
			<Handle type="target" position={Position.Left} id="stop" offset={1} />
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<OscillatorData>();

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

	return <IconWithValue icon={icon} value={data.period / 1000} suffix="s" />;
}

function Settings() {
	const { addBinding } = useNodeSettings<OscillatorData>();

	useEffect(() => {
		addBinding('waveform', {
			index: 0,
			view: 'list',
			label: 'validate',
			options: [
				{ value: 'sinus', text: 'sinus' },
				{ value: 'triangle', text: 'triangle' },
				{ value: 'sawtooth', text: 'sawtooth' },
				{ value: 'square', text: 'square' },
				{ value: 'random', text: 'random' },
			],
		});

		addBinding('period', {
			index: 1,
			step: 1,
			min: 100,
		});

		addBinding('amplitude', {
			index: 2,
			min: 0.1,
		});

		addBinding('phase', {
			index: 3,
		});

		addBinding('shift', {
			index: 4,
		});

		addBinding('autoStart', {
			index: 5,
			label: 'auto start',
		});
	}, [addBinding]);

	return null;
}

type Props = BaseNode<OscillatorData>;
Oscillator.defaultProps = {
	data: {
		group: 'flow',
		tags: ['input', 'generator'],
		label: 'Oscillator',
		waveform: 'sinus',
		period: 1000,
		amplitude: 1,
		phase: 0,
		shift: 0,
		autoStart: true,
		description: 'Generate a periodic signal with various waveforms',
	} satisfies Props['data'],
};
