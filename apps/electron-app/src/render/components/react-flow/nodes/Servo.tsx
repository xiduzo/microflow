import type { ServoData, ServoValueType } from '@microflow/components';
import { Icons, Input, Select, SelectContent, SelectItem, SelectTrigger } from '@microflow/ui';
import { Position, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { BoardCheckResult, MODES } from '../../../../common/types';
import { PinSelect } from '../../PinSelect';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
	useNode,
	useNodeSettings,
	useNodeSettingsPane,
} from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { useBoard } from '../../../providers/BoardProvider';
import { mapPinToPaneOption, pinValue } from '../../../../utils/pin';
import { BindingApi } from '@tweakpane/core';

const ROTATING_SERVO_STOP_DEGREES = 90;

function validatePin(pin: BoardCheckResult['pins'][0]) {
	return pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.PWM);
}

export function Servo(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
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

function Value() {
	const { id, data } = useNode();
	const value = useNodeValue<ServoValueType>(id, 0);

	const isStandard = data.type === 'standard';

	const animationDuration = useMemo(() => {
		if (isStandard) return 1.5;

		if (!value) return 0;

		if (value === ROTATING_SERVO_STOP_DEGREES) return 0;

		const diff =
			ROTATING_SERVO_STOP_DEGREES + 1 - Math.abs(ROTATING_SERVO_STOP_DEGREES - props.data.value);
		const rotationSpeedPercentage = diff / ROTATING_SERVO_STOP_DEGREES;
		const slowestTurningSpeed = 6;

		// TODO this is a very rough estimation
		return Math.max(slowestTurningSpeed * rotationSpeedPercentage, 1.25);
	}, [isStandard, value]);

	return (
		<section className="relative">
			{isStandard && (
				<div className="flex items-start z-10">
					{data.value}
					<span className="font-extralight">°</span>
				</div>
			)}
			{isStandard && (
				<>
					<div
						className="w-28 h-28 flex absolute"
						style={{
							rotate: `${data.range[0]}deg`,
						}}
					>
						<div
							className={`h-14 w-0.5 bg-gradient-to-b from-red-500/30 to-red-500/0 to-30% absolute`}
						></div>
					</div>
					<div
						className="w-28 h-28 flex absolute"
						style={{
							rotate: `${data.range[1]}deg`,
						}}
					>
						<div
							className={`h-14 w-0.5 bg-gradient-to-b from-green-500/30 to-green-500/0 to-30% absolute`}
						></div>
					</div>
				</>
			)}
			{value !== null && value !== undefined && (
				<div
					className={`w-28 h-28 flex absolute ${isStandard ? 'transition-all' : 'animate-spin'}`}
					style={{
						rotate: `${isStandard ? value : 0}deg`,
						animationDuration: `${animationDuration}s`,
						animationDirection:
							!isStandard && value < ROTATING_SERVO_STOP_DEGREES ? 'reverse' : 'normal',
					}}
				>
					<div
						className={`h-14 w-0.5 bg-gradient-to-b from-muted-foreground to-muted-foreground/0 to-${isStandard ? '60' : '95'}%  absolute`}
					></div>
					<Icons.Dot className={`w-8 h-8 absolute -top-4 text-muted-foreground`} />
				</div>
			)}
		</section>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<ServoData>();
	const { pins } = useBoard();

	useEffect(() => {
		if (!pane) return;

		let rangePane: BindingApi | undefined;

		function setRangePane() {
			rangePane?.dispose();
			if (settings.type === 'continuous') return;

			rangePane = pane.addBinding(settings, 'range', {
				index: 2,
				step: 1,
				min: 0,
				max: 360,
			});
		}
		pane.addBinding(settings, 'pin', {
			view: 'list',
			disabled: !pins.length,
			label: 'pin',
			index: 0,
			options: pins
				.filter(
					pin =>
						pin.supportedModes.includes(MODES.OUTPUT) && pin.supportedModes.includes(MODES.PWM),
				)
				.map(mapPinToPaneOption),
		});

		pane
			.addBinding(settings, 'type', {
				index: 1,
				options: [
					{ text: 'standaard', value: 'standard' },
					{ text: 'continuous', value: 'continuous' },
				],
			})
			.on('change', event => {
				setRangePane();
			});

		setRangePane();
	}, [pane, settings, pins]);

	return null;
}

type Props = BaseNode<ServoData, ServoValueType>;
export const DEFAULT_SERVO_DATA: Props['data'] = {
	value: 0,
	pin: 3,
	label: 'Servo',
	type: 'standard',
	range: { min: 0, max: 180 },
};
