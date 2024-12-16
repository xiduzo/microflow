import type { SensorData, SensorValueType } from '@microflow/components';
import { Icons, Progress } from '@microflow/ui';
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
			return (
				<section className="flex flex-col text-center gap-2">
					{progress <= 33 && <Icons.SunDim className={`text-yellow-500/30`} size={48} />}
					{progress > 33 && progress <= 66 && (
						<Icons.SunMedium className={`text-yellow-500/60`} size={48} />
					)}
					{progress > 66 && <Icons.Sun className={`text-yellow-500`} size={48} />}
				</section>
			);
		default:
			return (
				<Progress max={1023} value={progress} className="border border-muted-foreground mx-4" />
			);
	}
}

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
