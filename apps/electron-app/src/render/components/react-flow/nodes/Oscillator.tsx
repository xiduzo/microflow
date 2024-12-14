import type { OscillatorData, OscillatorValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';

const numberFormat = new Intl.NumberFormat();

export function Oscillator(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="reset" offset={-1.5} />
			<Handle type="target" position={Position.Left} id="start" offset={-0.5} />
			<Handle type="target" position={Position.Left} id="stop" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id, data } = useNode();
	const value = useNodeValue<OscillatorData>(id, 0);

	const waveform = data['waveform'];
	const period = data['period'];
	const amplitude = data['amplitude'];

	return (
		<section className="tabular-nums">
			{waveform}
			<br />[{-1 * amplitude},{amplitude}] @ {period / 1000} s
		</section>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<OscillatorData>();

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
			],
		});

		pane.addBinding(settings, 'period', {
			index: 1,
		});

		pane.addBinding(settings, 'amplitude', {
			index: 2,
		});

		pane.addBinding(settings, 'phase', {
			index: 4,
		});

		pane.addBinding(settings, 'shift', {
			index: 5,
		});
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<OscillatorData, OscillatorValueType>;
export const DEFAULT_OSCILLATOR_DATA: Props['data'] = {
	label: 'Oscillator',
	waveform: 'sinus',
	period: 1000,
	amplitude: 1,
	phase: 0,
	shift: 0,
};
