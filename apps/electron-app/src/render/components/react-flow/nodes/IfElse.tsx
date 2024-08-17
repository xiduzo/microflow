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
import { useUpdateNodeData } from '../../../hooks/nodeUpdater';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
} from './Node';

const MAX_NUMERIC_VALUE = 1023;

export function IfElse(props: Props) {
	const { updateNodeData } = useUpdateNodeData<IfElseData>(props.id);

	useEffect(() => {
		if (!props?.data) return;

		if (props.data.validator === 'number') {
			const isRange = ['between', 'outside'].includes(props.data.subValidator);
			const currentValue = Number(props.data.validatorArgs[0]);
			const validatorArgs = [currentValue];
			if (isRange) {
				const increment = (MAX_NUMERIC_VALUE + 1) * 0.25;
				const nextValueBackup =
					currentValue + increment >= MAX_NUMERIC_VALUE
						? currentValue - increment
						: currentValue + increment;
				const nextValue = Number(
					props.data.validatorArgs[1] ?? nextValueBackup,
				);
				if (nextValue > currentValue) {
					validatorArgs.push(nextValue);
				} else {
					validatorArgs.unshift(nextValue);
				}
			}

			if (props.data.validatorArgs.length === validatorArgs.length) {
				return;
			}

			updateNodeData({ validatorArgs });
		}
	}, [props.data.validator, props.data.subValidator, props.data.validatorArgs]);

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
				<section className="flex space-x-2 justify-between">
					<Select
						value={props.data.validator}
						onValueChange={value =>
							updateNodeData({
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
					{IF_ELSE_SUB_VALIDATORS[props.data.validator]?.length > 0 && (
						<Select
							disabled={!props.data.validator}
							value={props.data.subValidator}
							onValueChange={value =>
								updateNodeData({
									validator: props.data.validator,
									subValidator: value,
								})
							}
						>
							<SelectTrigger>
								<SelectValue placeholder="Validate with" />
							</SelectTrigger>
							<SelectContent>
								{IF_ELSE_SUB_VALIDATORS[props.data.validator]?.map(
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
				{props.data.validator === 'text' && (
					<Input
						value={String(props.data.validatorArgs[0])}
						type="text"
						placeholder="Expected value"
						onChange={e => updateNodeData({ validatorArgs: [e.target.value] })}
					/>
				)}
				{props.data.validator === 'number' &&
					!['is even', 'is odd'].includes(props.data.subValidator) && (
						<>
							<Label
								htmlFor={`slider-numeric-${props.id}`}
								className="flex justify-between"
							>
								{props.data.validatorArgs?.map((value, index) => (
									<span key={index} className="opacity-40 font-light">
										{String(value)}
									</span>
								))}
							</Label>
							<Slider
								id={`slider-if-else-${props.id}`}
								key={props.data.validatorArgs.length}
								defaultValue={
									(props.data.validatorArgs.filter(
										arg => arg !== undefined,
									) as number[]) ?? [0]
								}
								min={0}
								max={MAX_NUMERIC_VALUE}
								step={1}
								onValueChange={values =>
									updateNodeData({ validatorArgs: values })
								}
							/>
						</>
					)}
			</NodeSettings>
			<Handle type="target" position={Position.Left} id="check" />
			<Handle type="source" position={Position.Right} id="true" offset={-0.5} />
			<Handle type="source" position={Position.Right} id="false" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
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
