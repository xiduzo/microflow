import type { ServoData, ServoValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { MODES } from '../../../../common/types';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { mapPinToPaneOption } from '../../../../utils/pin';
import { BindingApi } from '@tweakpane/core';
import { usePins } from '../../../stores/board';

export function Servo(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			{props.data.type === 'standard' && (
				<>
					<Handle type="target" position={Position.Left} id="min" offset={-1} />
					<Handle type="target" position={Position.Left} id="to" />
					<Handle type="target" position={Position.Left} id="max" offset={1} />
				</>
			)}
			{props.data.type === 'continuous' && (
				<>
					<Handle
						type="target"
						position={Position.Left}
						id="rotate"
						hint="from -1 to 1"
						offset={-0.5}
					/>
					<Handle type="target" position={Position.Left} id="stop" offset={0.5} />
				</>
			)}
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id, data } = useNode<ServoData>();
	const value = useNodeValue<ServoValueType>(id, 0);

	if (data.type === 'continuous') {
		if (!value) return <Icons.Circle className="text-muted-foreground" size={48} />;
		if (value > 0) return <Icons.RotateCw className="animate-spin" size={48} />;
		return <Icons.RotateCcw className="animate-spin direction-reverse" size={48} />;
	}

	return (
		<section className="tabular-nums text-4xl">
			{value}
			<span className="font-extralight">°</span>
		</section>
	);
}

function Settings() {
	const { pane, settings, setHandlesToDelete } = useNodeSettingsPane<ServoData>();
	const pins = usePins();

	useEffect(() => {
		if (!pane) return;

		let rangePane: BindingApi | undefined;

		function setRangePane() {
			rangePane?.dispose();
			if (settings.type === 'continuous') return;

			rangePane = pane.addBinding(settings, 'range', {
				index: 2,
				step: 1,
				min: 0,
				max: 360,
			});
		}
		pane.addBinding(settings, 'pin', {
			view: 'list',
			disabled: !pins.length,
			label: 'pin',
			index: 0,
			options: pins
				.filter(
					pin =>
						pin.supportedModes.includes(MODES.OUTPUT) && pin.supportedModes.includes(MODES.PWM),
				)
				.map(mapPinToPaneOption),
		});

		pane
			.addBinding(settings, 'type', {
				index: 1,
				options: [
					{ text: 'standaard', value: 'standard' },
					{ text: 'continuous', value: 'continuous' },
				],
			})
			.on('change', event => {
				setRangePane();
			});

		setRangePane();
	}, [pane, settings, pins]);

	useEffect(() => {
		setHandlesToDelete(['min', 'to', 'max', 'rotate', 'stop']);
	}, [setHandlesToDelete]);

	return null;
}

type Props = BaseNode<ServoData, ServoValueType>;
export const DEFAULT_SERVO_DATA: Props['data'] = {
	pin: 3,
	label: 'Servo',
	type: 'standard',
	range: { min: 0, max: 180 },
};
