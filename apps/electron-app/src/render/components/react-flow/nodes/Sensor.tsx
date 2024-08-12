import {
    Progress,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
} from '@microflow/ui';
import { Position } from '@xyflow/react';
import { SensorOption } from 'johnny-five';
import { useMemo } from 'react';
import { BoardCheckResult, MODES } from '../../../../common/types';
import { useUpdateNodeData } from '../../../hooks/nodeUpdater';
import { useBoard } from '../../../providers/BoardProvider';
import { Handle } from './Handle';
import {
    BaseNode,
    NodeContainer,
    NodeContent,
    NodeSettings,
    NodeValue,
} from './Node';

function validatePin(pin: BoardCheckResult['pins'][0]) {
	return (
		pin.supportedModes.includes(MODES.INPUT) &&
		pin.supportedModes.includes(MODES.ANALOG)
	);
}

export function Sensor(props: Props) {
	const { pins } = useBoard();

	const { updateNodeData } = useUpdateNodeData<SensorData>(props.id);

	const hasValidPin = !!pins.find(
		pin => `A${pin.analogChannel}` === props.data.pin && validatePin(pin),
	);

	const progress = useMemo(() => {
		if (!props.data.value) return 0;

		return Math.round((props.data.value / 1023) * 100);
	}, [props.data.value]);

	return (
		<NodeContainer {...props}>
			<NodeContent>
				{!hasValidPin && (
					<div className="text-red-500 text-sm">
						Pin is not valid for a {props.type}
					</div>
				)}
				<NodeValue className="text-4xl tabular-nums">
					<Progress max={1023} value={progress} />
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<Select
					value={props.data.pin.toString()}
					onValueChange={value => updateNodeData({ pin: value })}
				>
					<SelectTrigger>Pin {props.data.pin}</SelectTrigger>
					<SelectContent>
						{pins.filter(validatePin).map(pin => (
							<SelectItem key={pin.pin} value={`A${pin.analogChannel}`}>
								Pin A{pin.analogChannel}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</NodeSettings>
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

export type SensorData = Omit<SensorOption, 'board'>;
type Props = BaseNode<SensorData, number>;
export const DEFAULT_SENSOR_DATA: Props['data'] = {
  value: 0,
  pin: 'A0',
	label: 'Sensor',
};
