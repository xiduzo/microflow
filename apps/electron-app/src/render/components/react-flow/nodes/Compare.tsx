import type { CompareData, CompateValueType } from '@microflow/components';
import {
	COMPARE_SUB_VALIDATORS,
	COMPARE_VALIDATORS,
	CompareValidator,
} from '@microflow/components/contants';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { BindingApi, BladeApi } from '@tweakpane/core';
import { useNodeValue } from '../../../stores/node-data';
import { IconWithValue } from '../IconWithValue';

export function Compare(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="check" />
			<Handle type="source" position={Position.Right} id="true" offset={-1} />
			<Handle type="source" position={Position.Right} id="false" />
			<Handle type="source" position={Position.Right} id="change" offset={1} />
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
					case 'equal to':
					case 'less than':
					case 'greater than':
						return `is ${data.subValidator} ${data.validatorArg}`;
					case 'even':
					case 'odd':
						return `is ${data.subValidator}`;
					case 'between':
					case 'outside':
						return `is ${data.subValidator} ${formatter.format(data.validatorArg.min)} and ${formatter.format(data.validatorArg.max)}`;
				}
				break;
			case 'text':
				switch (data.subValidator) {
					case 'includes':
					case 'starts with':
					case 'ends with':
						return `${data.subValidator} ${data.validatorArg}`;
					case 'equal to':
						return `is ${data.subValidator} ${data.validatorArg}`;
				}
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
	if (value) return <Icons.ShieldCheck className="text-green-500" size={48} />;
	return <Icons.ShieldX className="text-red-500" size={48} />;
}

function Settings() {
	const { pane, settings } = useNodeSettings<CompareData>();

	useEffect(() => {
		if (!pane) return;

		let subValidatorPane: BindingApi | undefined;
		let validatorArgPane: BladeApi | undefined;

		function addValidatorArgs() {
			if (!pane) return;

			validatorArgPane?.dispose();

			validatorArgPane = pane.addBinding(settings, 'validatorArg', {
				index: 2,
				label: '',
			});
		}

		function addSubValidator(validator: CompareValidator) {
			if (!pane) return;
			subValidatorPane?.dispose();

			subValidatorPane = pane
				.addBinding(settings, 'subValidator', {
					view: 'list',
					index: 1,
					label: 'is',
					options: COMPARE_SUB_VALIDATORS[validator].map(item => ({
						text: item,
						value: item,
					})),
				})
				.on('change', event => {
					switch (event.value) {
						case 'equal to':
						case 'includes':
						case 'starts with':
						case 'ends with':
							settings.validatorArg = settings.validatorArg ?? '';
							addValidatorArgs();
							break;
						case 'less than':
						case 'greater than':
							settings.validatorArg = isNaN(Number(settings.validatorArg))
								? 0
								: (settings.validatorArg ?? 0);
							addValidatorArgs();
							break;
						case 'between':
						case 'outside':
							settings.validatorArg = isNaN(Number(settings.validatorArg))
								? (settings.validatorArg ?? { min: 100, max: 500 })
								: { min: 100, max: 500 };
							addValidatorArgs();
							break;
						case 'even':
						case 'odd':
							validatorArgPane?.dispose();
							break;
						default:
							// Boolean
							break;
					}
				});

			if (settings.subValidator === 'odd') return;
			if (settings.subValidator === 'even') return;

			addValidatorArgs();
		}

		const validatorBinding = pane
			.addBinding(settings, 'validator', {
				index: 0,
				view: 'list',
				label: 'validate',
				options: COMPARE_VALIDATORS.map(validator => ({
					text: validator,
					value: validator,
				})),
			})
			.on('change', event => {
				switch (event.value) {
					case 'boolean':
						subValidatorPane?.dispose();
						validatorArgPane?.dispose();
						return;
					case 'number':
						settings.subValidator = 'equal to';
						settings.validatorArg = 0;
						addSubValidator(event.value);
						break;
					case 'text':
						settings.subValidator = 'includes';
						settings.validatorArg = '';
						addSubValidator(event.value);
						return;
				}
			});

		if (settings.validator !== 'boolean') addSubValidator(settings.validator);

		return () => {
			validatorBinding.dispose();
			subValidatorPane?.dispose();
			validatorArgPane?.dispose();
		};
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<CompareData>;
Compare.defaultProps = {
	data: {
		group: 'flow',
		tags: ['control'],
		label: 'Compare',
		validator: 'boolean',
	} satisfies Props['data'],
};
