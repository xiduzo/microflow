import type { SensorData, SensorValueType } from '@microflow/components';
import { Progress } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { MODES } from '../../../../common/types';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeSettings } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { mapPinToPaneOption } from '../../../../utils/pin';
import { usePins } from '../../../stores/board';

function Sensor(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<SensorValueType>(0);

	const progress = useMemo(() => Math.round((value / 1023) * 100), [value]);

	return <Progress max={1023} value={progress} className="border border-muted-foreground mx-4" />;
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
		baseType: 'Sensor',
	} satisfies Props['data'],
};

export const Potentiometer = (props: Props) => <Sensor {...props} />;
Potentiometer.defaultProps = {
	data: {
		...Sensor.defaultProps.data,
		label: 'Potentiometer',
		baseType: 'Sensor',
	} satisfies Props['data'],
};
