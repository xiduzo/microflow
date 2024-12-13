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
			<Handle type="target" position={Position.Left} id="reset" offset={-1} />
			<Handle type="target" position={Position.Left} id="start" />
			<Handle type="target" position={Position.Left} id="stop" offset={1} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id } = useNode();
	const value = useNodeValue<OscillatorValueType>(id, 0);

	return <section className="tabular-nums">{numberFormat.format(Math.round(value))}</section>;
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
