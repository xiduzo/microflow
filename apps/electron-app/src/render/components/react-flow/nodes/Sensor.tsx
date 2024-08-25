import type { SensorData, SensorValueType } from '@microflow/components';
import {
	Progress,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useMemo } from 'react';
import { BoardCheckResult, MODES } from '../../../../common/types';
import { useBoard } from '../../../providers/BoardProvider';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
	useNodeSettings,
} from './Node';

function validatePin(pin: BoardCheckResult['pins'][0]) {
	return (
		pin.supportedModes.includes(MODES.INPUT) &&
		pin.supportedModes.includes(MODES.ANALOG)
	);
}

export function Sensor(props: Props) {
	const progress = useMemo(() => {
		if (!props.data.value) return 0;

		return Math.round((props.data.value / 1023) * 100);
	}, [props.data.value]);

	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="text-4xl tabular-nums">
					<Progress max={1023} value={progress} />
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
	const { pins } = useBoard();

	const { settings, setSettings } = useNodeSettings<SensorData>();

	return (
		<>
			<Select
				value={settings.pin.toString()}
				onValueChange={value => setSettings({ pin: value })}
			>
				<SelectTrigger>Pin {settings.pin}</SelectTrigger>
				<SelectContent>
					{pins.filter(validatePin).map(pin => (
						<SelectItem key={pin.pin} value={`A${pin.analogChannel}`}>
							Pin A{pin.analogChannel}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</>
	);
}

type Props = BaseNode<SensorData, SensorValueType>;
export const DEFAULT_SENSOR_DATA: Props['data'] = {
	value: 0,
	pin: 'A0',
	label: 'Sensor',
};
