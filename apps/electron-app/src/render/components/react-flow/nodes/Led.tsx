import type { LedData, LedValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { MODES } from '../../../../common/types';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { useEffect, useMemo } from 'react';
import { mapPinToPaneOption, pinValue } from '../../../../utils/pin';
import { useNodeValue } from '../../../stores/node-data';
import { usePins } from '../../../stores/board';

export function Led(props: Props) {
	const pins = usePins();

	const isPmwPin = useMemo(() => {
		return pins.find(pin => pinValue(pin) === props.data.pin)?.supportedModes.includes(MODES.PWM);
	}, [pins, props.data.pin]);

	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="on" offset={-1.5} />
			<Handle type="target" position={Position.Left} id="toggle" offset={-0.5} />
			<Handle
				type="target"
				position={Position.Left}
				id="brightness"
				title={props.data.subType === 'vibration' ? 'intensity' : 'brightness'}
				offset={0.5}
				hint={`${isPmwPin ? '0-255' : 'requires PWM pin'}`}
				isConnectable={isPmwPin}
			/>
			<Handle type="target" position={Position.Left} id="off" offset={1.5} />
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData();
	const value = useNodeValue<LedValueType>(0);

	switch (data.subType) {
		case 'vibration':
			return <VibrationValue value={value} />;
		default:
			return <LedValue value={value} />;
	}
}

function LedValue(props: { value: number }) {
	if (!props.value) return <Icons.LightbulbOff className="text-muted-foreground" size={48} />;
	return (
		<Icons.Lightbulb
			className="text-yellow-500"
			size={48}
			style={{
				opacity: props.value > 1 ? props.value / 255 : 1, // Rhough dimmable LED
			}}
		/>
	);
}

function VibrationValue(props: { value: number }) {
	if (!props.value) return <Icons.VibrateOff className="text-muted-foreground" size={48} />;
	return (
		<section className="relative">
			<Icons.Vibrate
				className="text-orange-500 animate-wiggle"
				size={48}
				style={{
					animationDuration: `${250 + (250 - (props.value > 1 ? props.value / 255 : 1) * 250)}ms`,
				}}
			/>
			<div className="animate-ping w-8 h-8 bg-orange-500 rounded-full absolute left-[9px] right-0 bottom-0 top-2 -z-10"></div>
		</section>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettings<LedData>();
	const pins = usePins();

	useEffect(() => {
		if (!pane) return;

		const pinBinding = pane.addBinding(settings, 'pin', {
			view: 'list',
			disabled: !pins.length,
			label: 'pin',
			index: 0,
			options: pins.filter(pin => pin.supportedModes.includes(MODES.INPUT)).map(mapPinToPaneOption),
		});

		return () => {
			[pinBinding].forEach(disposable => disposable.dispose());
		};
	}, [pane, settings, pins]);

	return null;
}

type Props = BaseNode<LedData>;
Led.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['output', 'analog', 'digital'],
		label: 'LED',
		pin: 13,
	} satisfies Props['data'],
};

export const Vibration = (props: Props) => <Led {...props} />;
Vibration.defaultProps = {
	data: {
		...Led.defaultProps.data,
		label: 'Vibration',
		subType: 'vibration',
		baseType: 'Led',
	} satisfies Props['data'],
};
