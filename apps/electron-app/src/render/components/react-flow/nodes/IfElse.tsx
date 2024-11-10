import type { IfElseData, IfElseValueType } from '@microflow/components';
import {
	IF_ELSE_SUB_VALIDATORS,
	IF_ELSE_VALIDATORS,
	Validator,
} from '@microflow/components/contants';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { BindingApi, BladeApi } from '@tweakpane/core';
import { useNodeValue } from '../../../stores/node-data';

export function IfElse(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="check" />
			<Handle type="source" position={Position.Right} id="true" offset={-0.5} />
			<Handle type="source" position={Position.Right} id="false" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id } = useNode();
	const value = useNodeValue<IfElseValueType>(id, false);

	if (value) return <Icons.ShieldCheck className="text-green-500" size={48} />;
	return <Icons.ShieldX className="text-red-500" size={48} />;
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<IfElseData>();

	useEffect(() => {
		if (!pane) return;

		let subValidatorPane: BindingApi | undefined;
		let validatorArgPane: BladeApi | undefined;

		function addValidatorArgs() {
			validatorArgPane?.dispose();

			validatorArgPane = pane.addBinding(settings, 'validatorArg', {
				index: 2,
				step: 10,
				label: '',
			});
		}

		function addSubValidator(validator: Validator) {
			subValidatorPane?.dispose();

			subValidatorPane = pane
				.addBinding(settings, 'subValidator', {
					view: 'list',
					index: 1,
					label: 'is',
					options: IF_ELSE_SUB_VALIDATORS[validator].map(item => ({
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

		pane
			.addBinding(settings, 'validator', {
				index: 0,
				view: 'list',
				label: 'validate',
				options: IF_ELSE_VALIDATORS.map(validator => ({
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
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<IfElseData, IfElseValueType>;
export const DEFAULT_IF_ELSE_DATA: Props['data'] = {
	label: 'if...else',
	validator: 'boolean',
};
