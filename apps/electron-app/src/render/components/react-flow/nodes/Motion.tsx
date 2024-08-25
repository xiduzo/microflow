import type {
	Controller,
	MotionData,
	MotionValueType,
} from '@microflow/components';
import { MOTION_CONTROLLERS } from '@microflow/components/contants';
import {
	Icons,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from '@microflow/ui';
import { Position } from '@xyflow/react';
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
		!pin.supportedModes.includes(MODES.I2C)
	);
}

export function Motion(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="text-4xl tabular-nums">
					{Boolean(props.data.value) && <Icons.Eye className="w-10 h-10" />}
					{!Boolean(props.data.value) && (
						<Icons.EyeOff className="w-10 h-10 text-muted-foreground pulse" />
					)}
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<MotionSettings />
			</NodeSettings>
			<Handle
				type="source"
				position={Position.Right}
				id="motionstart"
				title="Motion started"
				offset={-0.5}
			/>
			<Handle
				type="source"
				position={Position.Right}
				id="motionend"
				title="Motion ended"
				offset={0.5}
			/>
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function MotionSettings() {
	const { pins } = useBoard();

	const { settings, setSettings } = useNodeSettings<MotionData>();

	return (
		<>
			<Select
				value={settings.controller}
				onValueChange={(value: Controller) =>
					setSettings({ controller: value })
				}
			>
				<SelectTrigger>{settings.controller}</SelectTrigger>
				<SelectContent>
					{MOTION_CONTROLLERS.map(controller => (
						<SelectItem key={controller} value={controller}>
							{controller}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Select
				value={settings.pin.toString()}
				onValueChange={value => setSettings({ pin: value })}
			>
				<SelectTrigger>Pin {settings.pin}</SelectTrigger>
				<SelectContent>
					{pins
						.filter(validatePin)
						.filter(validatedPin => {
							if (settings.controller === 'HCSR501') {
								return validatedPin.analogChannel === 127;
							} else {
								return validatedPin.analogChannel !== 127;
							}
						})
						.map(pin => (
							<SelectItem
								key={pin.pin}
								value={
									pin.analogChannel === 127
										? `${pin.pin}`
										: `A${pin.analogChannel}`
								}
							>
								Pin{' '}
								{pin.analogChannel === 127 ? pin.pin : `A${pin.analogChannel}`}
							</SelectItem>
						))}
				</SelectContent>
			</Select>
		</>
	);
}

type Props = BaseNode<MotionData, MotionValueType>;
export const DEFAULT_MOTION_DATA: Props['data'] = {
	value: false,
	pin: '8',
	label: 'Motion',
	controller: 'HCSR501',
};
