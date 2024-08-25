import type {
	IfElseData,
	IfElseValueType,
	SubValidator,
	Validator,
} from '@microflow/components';
import {
	IF_ELSE_SUB_VALIDATORS,
	IF_ELSE_VALIDATORS,
} from '@microflow/components/contants';
import {
	Icons,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Slider,
} from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
	useNodeSettings,
} from './Node';

const MAX_NUMERIC_VALUE = 1023;

export function IfElse(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue>
					{props.data.value === true && (
						<Icons.Check className="w-12 h-12 text-green-500" />
					)}
					{props.data.value === false && (
						<Icons.X className="w-12 h-12 text-red-500" />
					)}
					{props.data.value === null ||
						(props.data.value === undefined && (
							<Icons.Dot className="w-12 h-12 text-gray-500" />
						))}
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<IfElseSettings />
			</NodeSettings>
			<Handle type="target" position={Position.Left} id="check" />
			<Handle type="source" position={Position.Right} id="true" offset={-0.5} />
			<Handle type="source" position={Position.Right} id="false" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function IfElseSettings() {
	const { settings, setSettings } = useNodeSettings<IfElseData>();

	useEffect(() => {
		if (settings.validator === 'number') {
			const isRange = ['between', 'outside'].includes(settings.subValidator);
			const currentValue = Number(settings.validatorArgs[0]);
			const validatorArgs = [currentValue];
			if (isRange) {
				const increment = (MAX_NUMERIC_VALUE + 1) * 0.25;
				const nextValueBackup =
					currentValue + increment >= MAX_NUMERIC_VALUE
						? currentValue - increment
						: currentValue + increment;
				const nextValue = Number(settings.validatorArgs[1] ?? nextValueBackup);
				if (nextValue > currentValue) {
					validatorArgs.push(nextValue);
				} else {
					validatorArgs.unshift(nextValue);
				}
			}

			if (settings.validatorArgs.length === validatorArgs.length) {
				return;
			}

			setSettings({ validatorArgs });
		}
	}, [settings.validator, settings.subValidator, settings.validatorArgs]);

	return (
		<>
			<section className="flex space-x-2 justify-between">
				<Select
					value={settings.validator}
					onValueChange={value =>
						setSettings({
							validator: value as Validator,
							subValidator: IF_ELSE_SUB_VALIDATORS[value][0],
						})
					}
				>
					<SelectTrigger>
						<SelectValue placeholder="Validator" />
					</SelectTrigger>
					<SelectContent>
						{IF_ELSE_VALIDATORS.map(validator => (
							<SelectItem key={validator} value={validator}>
								{validator}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{IF_ELSE_SUB_VALIDATORS[settings.validator]?.length > 0 && (
					<Select
						disabled={!settings.validator}
						value={settings.subValidator}
						onValueChange={value =>
							setSettings({
								validator: settings.validator,
								subValidator: value,
							})
						}
					>
						<SelectTrigger>
							<SelectValue placeholder="Validate with" />
						</SelectTrigger>
						<SelectContent>
							{IF_ELSE_SUB_VALIDATORS[settings.validator]?.map(
								(subValidator: SubValidator) => (
									<SelectItem key={subValidator} value={subValidator}>
										{subValidator}
									</SelectItem>
								),
							)}
						</SelectContent>
					</Select>
				)}
			</section>
			{settings.validator === 'text' && (
				<Input
					value={String(settings.validatorArgs[0])}
					type="text"
					placeholder="Expected value"
					onChange={e => setSettings({ validatorArgs: [e.target.value] })}
				/>
			)}
			{settings.validator === 'number' &&
				!['is even', 'is odd'].includes(settings.subValidator) && (
					<>
						<Label htmlFor={`slider-if-else`} className="flex justify-between">
							{settings.validatorArgs?.map((value, index) => (
								<span key={index} className="opacity-40 font-light">
									{String(value)}
								</span>
							))}
						</Label>
						<Slider
							id={`slider-if-else`}
							key={settings.validatorArgs.length}
							defaultValue={
								(settings.validatorArgs.filter(
									arg => arg !== undefined,
								) as number[]) ?? [0]
							}
							min={0}
							max={MAX_NUMERIC_VALUE}
							step={1}
							onValueChange={validatorArgs => setSettings({ validatorArgs })}
						/>
					</>
				)}
		</>
	);
}

type Props = BaseNode<IfElseData, IfElseValueType>;
export const DEFAULT_IF_ELSE_DATA: Props['data'] = {
	label: 'if...else',
	value: false,
	validator: IF_ELSE_VALIDATORS[0],
	subValidator: IF_ELSE_SUB_VALIDATORS[IF_ELSE_VALIDATORS[0]][0],
	validatorArgs: [0, 1023],
};
