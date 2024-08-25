import type { LedData, LedValueType } from '@microflow/components';
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
import { MODES } from '../../../../common/types';
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

export function Led(props: Props) {
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
				<LedSettings />
			</NodeSettings>
			<Handle type="target" position={Position.Left} id="on" offset={-1} />
			<Handle type="target" position={Position.Left} id="toggle" />
			<Handle type="target" position={Position.Left} id="off" offset={1} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function LedSettings() {
	const { pins } = useBoard();

	const { settings, setSettings } = useNodeSettings<LedData>();

	return (
		<>
			<Select
				value={settings.pin.toString()}
				onValueChange={value => {
					setSettings({ pin: parseInt(value) });
				}}
			>
				<SelectTrigger>Pin {settings.pin}</SelectTrigger>
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
		</>
	);
}

type Props = BaseNode<LedData, LedValueType>;
export const DEFAULT_LED_DATA: Props['data'] = {
	label: 'LED',
	pin: 13,
	value: 0,
};
