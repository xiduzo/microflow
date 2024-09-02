import type { SensorData, SensorValueType } from '@microflow/components';
import { Progress } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useMemo } from 'react';
import { MODES } from '../../../../common/types';
import { PinSelect } from '../../PinSelect';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
	useNodeSettings,
} from './Node';

export function Sensor(props: Props) {
	const progress = useMemo(() => {
		if (!props.data.value) return 0;

		return Math.round((props.data.value / 1023) * 100);
	}, [props.data.value]);

	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="text-4xl">
					<Progress max={1023} value={progress} className="border border-muted-foreground/10" />
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<SensorSettings />
			</NodeSettings>
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function SensorSettings() {
	const { settings, setSettings } = useNodeSettings<SensorData>();

	return (
		<>
			<PinSelect
				value={settings.pin}
				onValueChange={pin => setSettings({ pin })}
				filter={pin =>
					pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.ANALOG)
				}
			/>
		</>
	);
}

type Props = BaseNode<SensorData, SensorValueType>;
export const DEFAULT_SENSOR_DATA: Props['data'] = {
	value: 0,
	pin: 'A0',
	label: 'Sensor',
};
