import type { ButtonData, ButtonValueType } from '@microflow/components';
import { Checkbox, Icons, Label, RadioGroup, RadioGroupItem, Slider, Toggle } from '@microflow/ui';
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

export function Button(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue>
					<Toggle
						disabled
						className="opacity-100 disabled:opacity-100"
						size="lg"
						pressed={Boolean(props.data.value)}
					>
						{Boolean(props.data.value) && <Icons.Pointer />}
						{!Boolean(props.data.value) && <Icons.PointerOff className="text-muted-foreground" />}
					</Toggle>
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<ButtonSettings />
			</NodeSettings>
			<Handle type="source" position={Position.Right} id="active" offset={-1} />
			<Handle type="source" position={Position.Right} id="hold" />
			<Handle type="source" position={Position.Right} id="inactive" offset={1} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function ButtonSettings() {
	const { settings, setSettings } = useNodeSettings<ButtonData>();

	return (
		<>
			<PinSelect
				value={settings.pin}
				onValueChange={pin => setSettings({ pin })}
				filter={pin => pin.supportedModes.includes(MODES.INPUT)}
			/>
			<Label htmlFor="holdtime" className="flex justify-between">
				Hold time
				<span className="opacity-40 font-light">{settings.holdtime} ms</span>
			</Label>
			<Slider
				id="holdtime"
				className="pb-2"
				defaultValue={[settings.holdtime]}
				min={500}
				max={2500}
				step={50}
				onValueChange={value => setSettings({ holdtime: value[0] })}
			/>
			<hr />
			<section className="flex justify-between items-start">
				<div
					className="flex items-center space-x-2"
					onClick={() => setSettings({ invert: !settings.invert })}
				>
					<Checkbox id="inverted" checked={settings.invert} />
					<span className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
						Invert button
					</span>
				</div>
				<RadioGroup
					defaultValue={settings.isPullup ? 'pullup' : settings.isPulldown ? 'pulldown' : 'default'}
					onValueChange={value => {
						switch (value) {
							case 'default':
								setSettings({ isPullup: false, isPulldown: false });
								break;
							case 'pullup':
								setSettings({ isPullup: true, isPulldown: false });
								break;
							case 'pulldown':
								setSettings({ isPullup: false, isPulldown: true });
								break;
						}
					}}
				>
					<div className="flex items-center space-x-2">
						<RadioGroupItem value="default" id="default" />
						<Label htmlFor="default">Normal button</Label>
					</div>
					<div className="flex items-center space-x-2">
						<RadioGroupItem value="pullup" id="pullup" />
						<Label htmlFor="pullup">Pullup button</Label>
					</div>
					<div className="flex items-center space-x-2">
						<RadioGroupItem value="pulldown" id="pulldown" />
						<Label htmlFor="pulldown">Pulldown button</Label>
					</div>
				</RadioGroup>
			</section>
		</>
	);
}

type Props = BaseNode<ButtonData, ButtonValueType>;
export const DEFAULT_BUTTON_DATA: Props['data'] = {
	value: false,
	holdtime: 500,
	isPulldown: false,
	isPullup: false,
	invert: false,
	pin: 6,
	label: 'Button',
};
