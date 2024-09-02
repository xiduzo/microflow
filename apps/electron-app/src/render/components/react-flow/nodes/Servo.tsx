import type { ServoData, ServoValueType } from '@microflow/components';
import { Icons, Input, Select, SelectContent, SelectItem, SelectTrigger } from '@microflow/ui';
import { Position, useUpdateNodeInternals } from '@xyflow/react';
import { useMemo } from 'react';
import { BoardCheckResult, MODES } from '../../../../common/types';
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

const ROTATING_SERVO_STOP_DEGREES = 90;

function validatePin(pin: BoardCheckResult['pins'][0]) {
	return pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.PWM);
}

export function Servo(props: Props) {
	const updateNodeInternals = useUpdateNodeInternals();

	const isStandard = props.data.type === 'standard';

	const animationDuration = useMemo(() => {
		if (isStandard) return 1.5;

		if (!props.data.value) return 0;

		if (props.data.value === ROTATING_SERVO_STOP_DEGREES) return 0;

		const diff =
			ROTATING_SERVO_STOP_DEGREES + 1 - Math.abs(ROTATING_SERVO_STOP_DEGREES - props.data.value);
		const rotationSpeedPercentage = diff / ROTATING_SERVO_STOP_DEGREES;
		const slowestTurningSpeed = 6;

		// TODO this is a very rough estimation
		return Math.max(slowestTurningSpeed * rotationSpeedPercentage, 1.25);
	}, [isStandard, props.data.value]);

	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="text-2xl flex items-center justify-center rounded-full w-28 h-28 p-0 min-w-[10px] m-auto">
					{isStandard && (
						<div className="flex items-start z-10">
							{props.data.value}
							<span className="font-extralight">°</span>
						</div>
					)}
					{isStandard && (
						<>
							<div
								className="w-28 h-28 flex absolute"
								style={{
									rotate: `${props.data.range[0]}deg`,
								}}
							>
								<div
									className={`h-14 w-0.5 bg-gradient-to-b from-red-500/30 to-red-500/0 to-30% left-[54px] absolute`}
								></div>
							</div>
							<div
								className="w-28 h-28 flex absolute"
								style={{
									rotate: `${props.data.range[1]}deg`,
								}}
							>
								<div
									className={`h-14 w-0.5 bg-gradient-to-b from-green-500/30 to-green-500/0 to-30% left-[54px] absolute`}
								></div>
							</div>
						</>
					)}
					{props.data.value !== null && props.data.value !== undefined && (
						<div
							className={`w-28 h-28 flex absolute ${isStandard ? 'transition-all' : 'animate-spin'}`}
							style={{
								rotate: `${isStandard ? props.data.value : 0}deg`,
								animationDuration: `${animationDuration}s`,
								animationDirection:
									!isStandard && props.data.value < ROTATING_SERVO_STOP_DEGREES
										? 'reverse'
										: 'normal',
							}}
						>
							<div
								className={`h-14 w-0.5 bg-gradient-to-b from-muted-foreground to-muted-foreground/0 to-${isStandard ? '60' : '95'}% left-[54px] absolute`}
							></div>
							<Icons.Dot className={`w-8 h-8 absolute -top-4 left-[39px] text-muted-foreground`} />
						</div>
					)}
				</NodeValue>
			</NodeContent>
			<NodeSettings
				onClose={() => {
					updateNodeInternals(props.id);
				}}
			>
				<ServoSettings />
			</NodeSettings>
			{props.data.type === 'standard' && (
				<Handle type="target" position={Position.Left} id="min" offset={-1} />
			)}
			{props.data.type === 'standard' && <Handle type="target" position={Position.Left} id="to" />}
			{props.data.type === 'standard' && (
				<Handle type="target" position={Position.Left} id="max" offset={1} />
			)}
			{props.data.type === 'continuous' && (
				<Handle
					type="target"
					position={Position.Left}
					id="rotate"
					hint="from -1 to 1"
					offset={-0.5}
				/>
			)}
			{props.data.type === 'continuous' && (
				<Handle type="target" position={Position.Left} id="stop" offset={0.5} />
			)}
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function ServoSettings() {
	const { settings, setSettings } = useNodeSettings<ServoData>();

	return (
		<>
			<PinSelect
				value={settings.pin}
				onValueChange={pin => setSettings({ pin })}
				filter={pin =>
					pin.supportedModes.includes(MODES.OUTPUT) && pin.supportedModes.includes(MODES.PWM)
				}
			/>
			<Select
				value={settings.type}
				onValueChange={value => {
					setSettings({ type: value });
				}}
			>
				<SelectTrigger className="first-letter:uppercase">{settings.type}</SelectTrigger>
				<SelectContent>
					<SelectItem value="standard">Standard</SelectItem>
					<SelectItem value="continuous">Continuous</SelectItem>
				</SelectContent>
			</Select>
			{settings.type === 'standard' && (
				<>
					<div>Servo range</div>
					<section className="flex space-x-2 justify-between items-center">
						<Input
							type="number"
							defaultValue={settings.range[0]}
							onChange={event =>
								setSettings({
									range: [Number(event.target.value), settings.range[1]],
								})
							}
						/>
						<span className="text-gray-800">-</span>
						<Input
							type="number"
							defaultValue={settings.range[1]}
							onChange={event =>
								setSettings({
									range: [settings.range[0], Number(event.target.value)],
								})
							}
						/>
					</section>
				</>
			)}
		</>
	);
}

type Props = BaseNode<ServoData, ServoValueType>;
export const DEFAULT_SERVO_DATA: Props['data'] = {
	value: 0,
	pin: 'A0',
	label: 'Servo',
	type: 'standard',
	range: [0, 180],
};
