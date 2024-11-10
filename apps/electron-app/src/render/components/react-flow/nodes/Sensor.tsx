import type { SensorData, SensorValueType } from '@microflow/components';
import { Progress } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { MODES } from '../../../../common/types';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { useBoard } from '../../../providers/BoardProvider';
import { mapPinToPaneOption } from '../../../../utils/pin';

export function Sensor(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id } = useNode();
	const value = useNodeValue<SensorValueType>(id, 0);

	const progress = useMemo(() => Math.round((value / 1023) * 100), [value]);

	return <Progress max={1023} value={progress} className="border border-muted-foreground mx-4" />;
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<SensorData>();
	const { pins } = useBoard();

	useEffect(() => {
		if (!pane) return;

		pane.addBinding(settings, 'pin', {
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
	}, [pane, settings, pins]);

	return null;
}

type Props = BaseNode<SensorData, SensorValueType>;
export const DEFAULT_SENSOR_DATA: Props['data'] = {
	pin: 'A0',
	label: 'Sensor',
};
