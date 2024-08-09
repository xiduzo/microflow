import {
	Icons,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from '@fhb/ui';
import { Position, useUpdateNodeInternals } from '@xyflow/react';
import { ServoGeneralOption } from 'johnny-five';
import { useMemo } from 'react';
import { BoardCheckResult, MODES } from '../../../../common/types';
import { useUpdateNodeData } from '../../../hooks/nodeUpdater';
import { useBoard } from '../../../providers/BoardProvider';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeHeader,
	NodeSettings,
} from './Node';

const ROTATING_SERVO_STOP_DEGREES = 90;

function validatePin(pin: BoardCheckResult['pins'][0]) {
	return (
		pin.supportedModes.includes(MODES.INPUT) &&
		pin.supportedModes.includes(MODES.PWM)
	);
}

export function Servo(props: Props) {
	const updateNodeInternals = useUpdateNodeInternals();
	const { pins } = useBoard();

	const { updateNodeData } = useUpdateNodeData<ServoData>(props.id);

	const hasValidPin = !!pins.find(
		pin => pin.pin === Number(props.data.pin) && validatePin(pin),
	);

	const isStandard = props.data.type === 'standard';

	const animationDuration = useMemo(() => {
		if (isStandard) return 1.5;

		if (!props.data.value) return 0;

		if (props.data.value === ROTATING_SERVO_STOP_DEGREES) return 0;

		const diff =
			ROTATING_SERVO_STOP_DEGREES +
			1 -
			Math.abs(ROTATING_SERVO_STOP_DEGREES - props.data.value);
		const rotationSpeedPercentage = diff / ROTATING_SERVO_STOP_DEGREES;
		const slowestTurningSpeed = 6;

		// TODO this is a very rough estimation
		return Math.max(slowestTurningSpeed * rotationSpeedPercentage, 1.25);
	}, [isStandard, props.data.value]);

	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeHeader className="text-2xl flex items-center justify-center rounded-full w-24 h-24 p-0 min-w-[10px] m-auto">
					{isStandard && (
						<div className="flex items-start z-10">
							{props.data.value ?? 0}
							<span className="font-extralight">°</span>
						</div>
					)}
					{isStandard && (
						<>
							<div
								className="w-24 h-24 flex absolute"
								style={{
									rotate: `${props.data.range[0]}deg`,
								}}
							>
								<div
									className={`h-12 w-0.5 bg-gradient-to-b from-red-500/30 to-red-500/0 to-30% left-[47px] absolute`}
								></div>
							</div>
							<div
								className="w-24 h-24 flex absolute"
								style={{
									rotate: `${props.data.range[1]}deg`,
								}}
							>
								<div
									className={`h-12 w-0.5 bg-gradient-to-b from-green-500/30 to-green-500/0 to-30% left-[47px] absolute`}
								></div>
							</div>
						</>
					)}
					{props.data.value !== null && props.data.value !== undefined && (
						<div
							className={`w-24 h-24 flex absolute ${isStandard ? 'transition-all' : 'animate-spin'}`}
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
								className={`h-12 w-0.5 bg-gradient-to-b from-primary to-primary/0 to-${isStandard ? '60' : '95'}% left-[47px] absolute`}
							></div>
							<Icons.Dot className={`w-8 h-8 absolute -top-4 left-8`} />
						</div>
					)}
				</NodeHeader>
				{!hasValidPin && (
					<div className="text-red-500 text-sm">
						Pin is not valid for a servo
					</div>
				)}
			</NodeContent>
			<NodeSettings>
				<Select
					value={props.data.pin.toString()}
					onValueChange={value => updateNodeData({ pin: value })}
				>
					<SelectTrigger>Pin {props.data.pin}</SelectTrigger>
					<SelectContent>
						{pins.filter(validatePin).map(pin => (
							<SelectItem key={pin.pin} value={pin.pin.toString()}>
								Pin {pin.pin}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={props.data.type}
					onValueChange={value => {
						updateNodeData({ type: value });
						updateNodeInternals(props.id);
					}}
				>
					<SelectTrigger className="first-letter:uppercase">
						{props.data.type}
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="standard">Standard</SelectItem>
						<SelectItem value="continuous">Continuous</SelectItem>
					</SelectContent>
				</Select>
				{isStandard && (
					<>
						<div>Servo range</div>
						<section className="flex space-x-2 justify-between items-center">
							<Input
								type="number"
								defaultValue={props.data.range[0]}
								onChange={event =>
									updateNodeData({
										range: [Number(event.target.value), props.data.range[1]],
									})
								}
							/>
							<span className="text-gray-800">-</span>
							<Input
								type="number"
								defaultValue={props.data.range[1]}
								onChange={event =>
									updateNodeData({
										range: [props.data.range[0], Number(event.target.value)],
									})
								}
							/>
						</section>
					</>
				)}
			</NodeSettings>
			{props.data.type === 'standard' && (
				<Handle type="target" position={Position.Left} id="min" offset={-1} />
			)}
			{props.data.type === 'standard' && (
				<Handle type="target" position={Position.Left} id="to" />
			)}
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

export type ServoData = Omit<ServoGeneralOption, 'board'>;
type Props = BaseNode<ServoData, number>;
