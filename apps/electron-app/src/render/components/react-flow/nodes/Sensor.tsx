import type { SensorData, SensorValueType } from '@microflow/components';
import { cva, Icons, Progress, VariantProps } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { MODES } from '../../../../common/types';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { mapPinToPaneOption } from '../../../../utils/pin';
import { usePins } from '../../../stores/board';

function Sensor(props: Props) {
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

	const progress = useMemo(() => Math.round((value / 1023) * 100), [value]);

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
					<span className="text-xs">{progress}%</span>
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
	const { pane, settings } = useNodeSettings<SensorData>();
	const pins = usePins();

	useEffect(() => {
		if (!pane) return;

		const pinBinding = pane.addBinding(settings, 'pin', {
			view: 'list',
			disabled: !pins.length,
			label: 'pin',
			index: 0,
			options: pins
				.filter(
					pin =>
						pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.ANALOG),
				)
				.map(mapPinToPaneOption),
		});

		return () => {
			[pinBinding].forEach(disposable => disposable.dispose());
		};
	}, [pane, settings, pins]);

	return null;
}

type Props = BaseNode<SensorData>;
Sensor.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['input', 'analog'],
		pin: 'A0',
		label: 'Sensor',
	} satisfies Props['data'],
};

export const Ldr = (props: Props) => <Sensor {...props} />;
Ldr.defaultProps = {
	data: {
		...Sensor.defaultProps.data,
		label: 'LDR',
		subType: 'ldr',
		baseType: 'Sensor',
	} satisfies Props['data'],
};

export const Potentiometer = (props: Props) => <Sensor {...props} />;
Potentiometer.defaultProps = {
	data: {
		...Sensor.defaultProps.data,
		label: 'Potentiometer',
		subType: 'potentiometer',
		baseType: 'Sensor',
	} satisfies Props['data'],
};

export const Force = (props: Props) => <Sensor {...props} />;
Force.defaultProps = {
	data: {
		...Sensor.defaultProps.data,
		label: 'Force',
		subType: 'force',
		baseType: 'Sensor',
	} satisfies Props['data'],
};

export const HallEffect = (props: Props) => <Sensor {...props} />;
HallEffect.defaultProps = {
	data: {
		...Sensor.defaultProps.data,
		label: 'Hall Effect',
		subType: 'hall-effect',
		baseType: 'Sensor',
	} satisfies Props['data'],
};
