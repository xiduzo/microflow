import type { OscillatorData } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { Icons } from '@ui/index';

export function Oscillator(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="reset" offset={-1} />
			<Handle type="target" position={Position.Left} id="start" />
			<Handle type="target" position={Position.Left} id="stop" offset={1} />
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<OscillatorData>();

	return (
		<section className="flex flex-col text-center gap-1">
			{data.waveform === 'random' && <Icons.Dices size={48} />}
			{data.waveform === 'sawtooth' && <Icons.TriangleRight size={48} />}
			{data.waveform === 'sinus' && <Icons.AudioWaveform size={48} />}
			{data.waveform === 'square' && <Icons.Square size={48} />}
			{data.waveform === 'triangle' && <Icons.Triangle size={48} />}
			<div className="text-muted-foreground text-xs">{data.period / 1000}s</div>
		</section>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettings<OscillatorData>();

	useEffect(() => {
		if (!pane) return;

		pane.addBinding(settings, 'waveform', {
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

		pane.addBinding(settings, 'period', {
			index: 1,
			step: 1,
			min: 100,
		});

		pane.addBinding(settings, 'amplitude', {
			index: 2,
			min: 0.1,
		});

		pane.addBinding(settings, 'phase', {
			index: 3,
		});

		pane.addBinding(settings, 'shift', {
			index: 4,
		});

		pane.addBinding(settings, 'autoStart', {
			index: 5,
		});
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<OscillatorData>;
Oscillator.defaultProps = {
	data: {
		group: 'flow',
		tags: ['generator', 'input'],
		label: 'Oscillator',
		waveform: 'sinus',
		period: 1000,
		amplitude: 1,
		phase: 0,
		shift: 0,
		autoStart: true,
	} satisfies Props['data'],
};
