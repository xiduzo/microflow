import {
	Icons,
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
} from '@microflow/ui';
import { Position } from '@xyflow/react';
import { LedOption } from 'johnny-five';
import { MODES } from '../../../../common/types';
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

export function Led(props: Props) {
	const { updateNodeData } = useUpdateNodeData<LedData>(props.id);

	const { pins } = useBoard();

	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue>
					{Boolean(props.data.value) && (
						<Icons.Lightbulb className="w-10 h-10" />
					)}
					{!Boolean(props.data.value) && (
						<Icons.LightbulbOff className="w-10 h-10 text-muted-foreground" />
					)}
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<Select
					value={props.data.pin.toString()}
					onValueChange={value => {
						updateNodeData({ pin: parseInt(value) });
					}}
				>
					<SelectTrigger>Pin {props.data.pin}</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							<SelectLabel>Set led pin</SelectLabel>
							{pins
								.filter(pin => pin.supportedModes.includes(MODES.INPUT))
								.map(pin => (
									<SelectItem key={pin.pin} value={pin.pin.toString()}>
										Pin {pin.pin}
									</SelectItem>
								))}
						</SelectGroup>
					</SelectContent>
				</Select>
			</NodeSettings>
			<Handle type="target" position={Position.Left} id="on" offset={-1} />
			<Handle type="target" position={Position.Left} id="toggle" />
			<Handle type="target" position={Position.Left} id="off" offset={1} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

export type LedData = Omit<LedOption, 'board'>;
type Props = BaseNode<LedData, number>;
export const DEFAULT_LED_DATA: Props['data'] = {
	label: 'LED',
	pin: 13,
	value: 0,
};
