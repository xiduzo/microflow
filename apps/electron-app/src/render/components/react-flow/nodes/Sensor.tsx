import type { SensorData, SensorValueType } from '@microflow/components';
import { cva, folder, Icons, Progress, Switch, VariantProps } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { MODES } from '../../../../common/types';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, NodeSettings, useNodeData } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { mapPinsToSettings } from '../../../../utils/pin';
import { usePins } from '../../../stores/board';

export function Sensor(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<SensorValueType>(0);
	const data = useNodeData<SensorData>();

	const progress = Math.round((value / 1023) * 100);

	if (data.type === 'digital') {
		return <Switch checked={Boolean(value)} className="scale-150" />;
	}

	switch (data.subType) {
		case 'ldr':
			if (progress <= 33) return <Icons.SunDim className={`text-yellow-500/30`} size={48} />;
			if (progress <= 66) return <Icons.SunMedium className={`text-yellow-500/60`} size={48} />;
			if (progress > 66) return <Icons.Sun className={`text-yellow-500`} size={48} />;
			break;
		case 'force':
			return (
				<Icons.BicepsFlexed
					size={48}
					className="transition-all"
					style={{ transform: `scale(${1 + progress / 100})` }}
				/>
			);
		case 'potentiometer':
			return (
				<Icons.CircleArrowOutUpLeft
					size={48}
					className="transition-all"
					style={{
						transform: `rotate(${progress * 2.7 - 90}deg)`,
					}}
				/>
			);
		case 'tilt':
			return (
				<Icons.MoveUp
					size={48}
					className="transition-all"
					style={{
						transform: `rotate(${progress < 50 ? 180 : 0}deg)`,
					}}
				/>
			);
		case 'hall-effect':
			return (
				<>
					<Icons.Magnet
						size={48}
						className={hallEffect({
							polarity: (Math.round(progress / 10) * 10) as HallEffectProps['polarity'],
						})}
						style={{
							transform: `rotate(${progress * (360 / 100 / 2) + 135}deg)`,
						}}
					/>
				</>
			);
		default:
			return (
				<Progress max={1023} value={progress} className="border border-muted-foreground mx-4" />
			);
	}
}

type HallEffectProps = VariantProps<typeof hallEffect>;
const hallEffect = cva('transition-all', {
	variants: {
		polarity: {
			0: 'text-red-600',
			10: 'text-red-500',
			20: 'text-red-400',
			30: 'text-red-300',
			40: 'text-red-200',
			50: 'text-gray-200',
			60: 'text-blue-200',
			70: 'text-blue-300',
			80: 'text-blue-400',
			90: 'text-blue-500',
			100: 'text-blue-600',
		},
	},
});

function Settings() {
	const data = useNodeData<SensorData & { subType?: string }>();
	const pins = usePins([MODES.INPUT, MODES.ANALOG]);

	return (
		<NodeSettings
			settings={{
				pin: {
					value: data.pin,
					options: pins.reduce(mapPinsToSettings, {}),
				},
				advanced: folder({
					threshold: { min: 0, step: 1, value: data.threshold! },
					freq: { min: 10, step: 1, value: data.freq! },
				}),
			}}
		/>
	);
}

type Props = BaseNode<SensorData>;
Sensor.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['input', 'analog'],
		pin: 'A0',
		label: 'Analog Sensor',
		threshold: 1,
		freq: 25,
		description: 'Read analog sensor values',
	} satisfies Props['data'],
};

export const DigitalSensor = (props: Props) => <Sensor {...props} />;
DigitalSensor.defaultProps = {
	data: {
		...Sensor.defaultProps.data,
		label: 'Digital Sensor',
		tags: ['input', 'digital'],
		type: 'digital',
		baseType: 'Sensor',
		description: 'Read digital sensor values',
	} satisfies Props['data'],
};

export const Tilt = (props: Props) => <Sensor {...props} />;
Tilt.defaultProps = {
	data: {
		...Sensor.defaultProps.data,
		label: 'Tilt',
		subType: 'tilt',
		baseType: 'Sensor',
		threshold: 10,
		description: 'Detect if something is up or down',
	} satisfies Props['data'],
};

export const Ldr = (props: Props) => <Sensor {...props} />;
Ldr.defaultProps = {
	data: {
		...Sensor.defaultProps.data,
		label: 'Light Dependent Resistor (LDR)',
		subType: 'ldr',
		baseType: 'Sensor',
		description: 'Measure the luminosity of a place',
	} satisfies Props['data'],
};

export const Potentiometer = (props: Props) => <Sensor {...props} />;
Potentiometer.defaultProps = {
	data: {
		...Sensor.defaultProps.data,
		label: 'Potentiometer',
		subType: 'potentiometer',
		baseType: 'Sensor',
		description: 'A rotary or linear controller',
	} satisfies Props['data'],
};

export const Force = (props: Props) => <Sensor {...props} />;
Force.defaultProps = {
	data: {
		...Sensor.defaultProps.data,
		label: 'Force',
		subType: 'force',
		baseType: 'Sensor',
		description: 'Detect force applied to a surface',
	} satisfies Props['data'],
};

export const HallEffect = (props: Props) => <Sensor {...props} />;
HallEffect.defaultProps = {
	data: {
		...Sensor.defaultProps.data,
		label: 'Hall Effect',
		subType: 'hall-effect',
		baseType: 'Sensor',
		description: 'Detect magnetic fields',
	} satisfies Props['data'],
};
