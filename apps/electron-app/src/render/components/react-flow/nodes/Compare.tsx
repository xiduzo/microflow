import type { CompareData, CompateValueType } from '@microflow/components';
import { COMPARE_SUB_VALIDATORS, COMPARE_VALIDATORS } from '@microflow/components/contants';
import { Position } from '@xyflow/react';
import { useMemo } from 'react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, NodeSettings, useNodeControls, useNodeData } from './Node';
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
					case 'equal to':
					case 'less than':
					case 'greater than':
						return `is ${data.subValidator} ${formatter.format(data.validatorArg)}`;
					case 'even':
					case 'odd':
						return `is ${data.subValidator}`;
					case 'between':
					case 'outside':
						return `is ${data.subValidator} ${formatter.format(data.validatorArg.min)} and ${formatter.format(data.validatorArg.max)}`;
				}
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
}

function Settings() {
	const data = useNodeData<CompareData>();

	const { render } = useNodeControls(
		{
			validator: { value: data.validator, options: COMPARE_VALIDATORS },
			subvalidator: {
				value: data.subValidator ?? COMPARE_SUB_VALIDATORS[data.validator].at(0),
				options: COMPARE_SUB_VALIDATORS[data.validator],
				render: get => get('validator') !== 'boolean',
			},
			validatorArgs: data.validatorArg!,
		},
		[data.validator, data.subValidator],
	);

	return <>{render()}</>;

	// useEffect(() => {
	// 	// if (!pane) return;

	// 	// let subValidatorPane: BindingApi | undefined;
	// 	// let validatorArgPane: BladeApi | undefined;

	// 	// // TODO: dynamic bindings
	// 	// function addValidatorArgs() {
	// 	// 	if (!pane) return;

	// 	// 	validatorArgPane?.dispose();

	// 	// 	validatorArgPane = pane.addBinding(settings, 'validatorArg', {
	// 	// 		index: 2,
	// 	// 		label: '',
	// 	// 	});
	// 	// }

	// 	// function addSubValidator(validator: CompareValidator) {
	// 	// 	if (!pane) return;
	// 	// 	subValidatorPane?.dispose();

	// 	// 	if (settings.subValidator === 'odd') return;
	// 	// 	if (settings.subValidator === 'even') return;

	// 	// 	addValidatorArgs();
	// 	// }

	// 	addBinding('validator', {
	// 		index: 0,
	// 		view: 'list',
	// 		label: 'validate',
	// 		options: COMPARE_VALIDATORS.map(validator => ({ text: validator, value: validator })),
	// 		change: event => {
	// 			switch (event.value) {
	// 				case 'boolean':
	// 					// subValidatorPane?.dispose();
	// 					// validatorArgPane?.dispose();
	// 					return;
	// 				case 'number':
	// 					settings.subValidator = 'equal to';
	// 					settings.validatorArg = 0;
	// 					// addSubValidator(event.value);
	// 					break;
	// 				case 'text':
	// 					settings.subValidator = 'includes';
	// 					settings.validatorArg = '';
	// 					// addSubValidator(event.value);
	// 					return;
	// 			}
	// 		},
	// 	});

	// 	// addBinding('subValidator', {
	// 	// 	view: 'list',
	// 	// 	index: 1,
	// 	// 	label: 'is',
	// 	// 	options: COMPARE_SUB_VALIDATORS[settings.validator].map(item => ({
	// 	// 		text: item,
	// 	// 		value: item,
	// 	// 	})),
	// 	// 	change: event => {
	// 	// 		console.log(event);
	// 	// 	},
	// 	// });
	// 	// .on('change', event => {
	// 	// 	switch (event.value) {
	// 	// 		case 'equal to':
	// 	// 		case 'includes':
	// 	// 		case 'starts with':
	// 	// 		case 'ends with':
	// 	// 			settings.validatorArg = settings.validatorArg ?? '';
	// 	// 			addValidatorArgs();
	// 	// 			break;
	// 	// 		case 'less than':
	// 	// 		case 'greater than':
	// 	// 			settings.validatorArg = isNaN(Number(settings.validatorArg))
	// 	// 				? 0
	// 	// 				: (settings.validatorArg ?? 0);
	// 	// 			addValidatorArgs();
	// 	// 			break;
	// 	// 		case 'between':
	// 	// 		case 'outside':
	// 	// 			settings.validatorArg = isNaN(Number(settings.validatorArg))
	// 	// 				? (settings.validatorArg ?? { min: 100, max: 500 })
	// 	// 				: { min: 100, max: 500 };
	// 	// 			addValidatorArgs();
	// 	// 			break;
	// 	// 		case 'even':
	// 	// 		case 'odd':
	// 	// 			validatorArgPane?.dispose();
	// 	// 			break;
	// 	// 		default:
	// 	// 			// Boolean
	// 	// 			break;
	// 	// 	}
	// 	// });
	// 	//
	// 	// addBinding('validatorArg', { index: 2, label: '', hidden: settings.validator === 'boolean' });
	// }, [settings, addBinding]);

	// return null;
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
