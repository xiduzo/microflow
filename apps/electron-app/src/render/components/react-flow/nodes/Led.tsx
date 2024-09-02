import type { LedData, LedValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
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

export function Led(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue>
					{Boolean(props.data.value) && <Icons.Lightbulb className="w-10 h-10" />}
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
	const { settings, setSettings } = useNodeSettings<LedData>();

	return (
		<>
			<PinSelect
				value={settings.pin}
				onValueChange={pin => setSettings({ pin })}
				filter={pin =>
					pin.supportedModes.includes(MODES.OUTPUT) && !pin.supportedModes.includes(MODES.ANALOG)
				}
			/>
		</>
	);
}

type Props = BaseNode<LedData, LedValueType>;
export const DEFAULT_LED_DATA: Props['data'] = {
	label: 'LED',
	pin: 13,
	value: 0,
};
