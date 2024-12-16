import type { ServoData, ServoValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { MODES } from '../../../../common/types';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
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
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<ServoData>();
	const value = useNodeValue<ServoValueType>(data.range.min);

	if (data.type === 'continuous') {
		if (!value) return <Icons.Circle className="text-muted-foreground" size={48} />;
		if (value > 0) return <Icons.RotateCw className="animate-spin" size={48} />;
		return <Icons.RotateCcw className="animate-spin direction-reverse" size={48} />;
	}

	return (
		<section className="relative">
			<section
				className="origin-bottom absolute transition-all"
				style={{ rotate: `${data.range.min - 90}deg` }}
			>
				<Icons.Slash className="-rotate-45 text-red-500/10" size={48} />
			</section>
			<section
				className="origin-bottom absolute transition-all"
				style={{ rotate: `${data.range.max - 90}deg` }}
			>
				<Icons.Slash className="-rotate-45 text-green-500/10" size={48} />
			</section>
			<section className="origin-bottom transition-all" style={{ rotate: `${value - 90}deg` }}>
				<Icons.Slash className="-rotate-45 text-muted-foreground" size={48} />
			</section>
			<div className="absolute w-4 h-4 left-4 -bottom-2 rounded-full bg-muted-foreground" />
		</section>
	);
}

function Settings() {
	const { pane, settings, setHandlesToDelete } = useNodeSettings<ServoData>();
	const pins = usePins();

	useEffect(() => {
		if (!pane) return;

		let rangeBinding: BindingApi | undefined;

		const intialType = settings.type;

		function setRangePane() {
			if (!pane) return;
			rangeBinding?.dispose();
			if (settings.type === 'continuous') return;

			rangeBinding = pane.addBinding(settings, 'range', {
				index: 2,
				step: 1,
				min: 0,
				max: 180,
			});
		}

		const pinBinding = pane.addBinding(settings, 'pin', {
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

		const typeBinding = pane
			.addBinding(settings, 'type', {
				index: 1,
				options: [
					{ text: 'standaard', value: 'standard' },
					{ text: 'continuous', value: 'continuous' },
				],
			})
			.on('change', ({ value }) => {
				setRangePane();

				if (value === intialType) setHandlesToDelete([]);
				else setHandlesToDelete(value === 'standard' ? ['min', 'to', 'max'] : ['rotate', 'stop']);
			});

		setRangePane();

		return () => {
			[rangeBinding, pinBinding, typeBinding].forEach(disposable => disposable?.dispose());
		};
	}, [pane, settings, pins, setHandlesToDelete]);

	return null;
}

type Props = BaseNode<ServoData>;
Servo.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['output', 'analog'],
		pin: 3,
		label: 'Servo',
		type: 'standard',
		range: { min: 0, max: 180 },
	} satisfies Props['data'],
};
