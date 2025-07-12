import type { CompareData, CompateValueType } from '@microflow/components';
import {
	COMPARE_SUB_VALIDATORS,
	COMPARE_VALIDATORS,
	CompareSubValidator,
} from '@microflow/components/contants';
import { Position } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { IconWithValue } from '../IconWithValue';

export function Compare(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="check" />
			<Handle type="source" position={Position.Right} id="true" offset={-1} />
			<Handle type="source" position={Position.Right} id="change" />
			<Handle type="source" position={Position.Right} id="false" offset={1} />
		</NodeContainer>
	);
}

const formatter = new Intl.NumberFormat('en-US');

function Value() {
	const value = useNodeValue<CompateValueType>(false);
	const data = useNodeData<CompareData>();

	const textValue = useMemo(() => {
		switch (data.validator) {
			case 'boolean':
				return 'boolean';
			case 'number':
				switch (data.subValidator) {
					case 'even':
					case 'odd':
						return `is ${data.subValidator}`;
					case 'equal to':
					case 'less than':
					case 'greater than':
						return `is ${data.subValidator} ${formatter.format(data.numberCompare)}`;
					case 'between':
					case 'outside':
						return `is ${data.subValidator} ${formatter.format(data.rangeCompare?.min)} and ${formatter.format(data.rangeCompare?.max)}`;
				}
			case 'text':
				return `is ${data.subValidator} "${data.textCompare}"`;
			default:
				return '';
		}
	}, [data]);

	return (
		<IconWithValue
			icon={value ? 'ShieldCheck' : 'ShieldX'}
			iconClassName={value ? 'text-green-500' : 'text-red-500'}
			value={textValue}
		/>
	);
}

function Settings() {
	const [subValidatorOptions, setSubValidatorOptions] = useState<readonly CompareSubValidator[]>(
		[],
	);
	const data = useNodeData<CompareData>();

	const { render, set } = useNodeControls(
		{
			validator: {
				value: data.validator,
				options: [...COMPARE_VALIDATORS],
				label: 'validate that a',
			},
			subValidator: {
				label: 'is',
				value: data.subValidator,
				options: subValidatorOptions,
				render: get => get('validator') !== 'boolean',
			},
			rangeCompare: {
				value: (data as { rangeCompare: { min: number; max: number } }).rangeCompare ?? {
					min: 100,
					max: 500,
				},
				label: '',
				joystick: false,
				render: get => ['between', 'outside'].includes(get('subValidator')),
			},
			numberCompare: {
				value: (data as { numberCompare: number }).numberCompare ?? 0,
				label: '',
				step: 1,
				render: get =>
					get('validator') === 'number' &&
					!['between', 'outside', 'even', 'odd'].includes(get('subValidator')),
			},
			textCompare: {
				value: (data as { textCompare: string }).textCompare ?? '',
				label: '',
				render: get => get('validator') === 'text',
			},
		},
		[subValidatorOptions],
	);

	useEffect(() => {
		const options = [...COMPARE_SUB_VALIDATORS[data.validator]];
		const subValidator = options.includes(data.subValidator as never)
			? data.subValidator
			: options.at(0);

		setSubValidatorOptions(options);

		if (data.subValidator === subValidator) return;

		set({ subValidator });
	}, [data.validator, data.subValidator, set]);

	return <>{render()}</>;
}

type Props = BaseNode<CompareData>;
Compare.defaultProps = {
	data: {
		group: 'flow',
		tags: ['control'],
		label: 'Compare',
		validator: 'boolean',
		subValidator: undefined,
		validatorArg: undefined,
		description: 'Validate and compare signals',
	} satisfies Props['data'],
};
