import { transformValueToBoolean } from '../utils/transformUnknownValues';
import { BaseComponent, BaseComponentData } from './BaseComponent';
import { COMPARE_SUB_VALIDATORS } from '../constants/Compare';

type BooleanData = {
	validator: 'boolean';
	subValidator?: never;
	validatorArg?: never;
};

type TextData = {
	validator: 'text';
	subValidator: (typeof COMPARE_SUB_VALIDATORS)['text'][number];
	validatorArg: string;
};

type NumberData = {
	validator: 'number';
	subValidator: Extract<(typeof COMPARE_SUB_VALIDATORS)['number'][number], 'even' | 'odd'>;
	validatorArg: never;
};

type SingleNumberData = {
	validator: 'number';
	subValidator: Exclude<
		(typeof COMPARE_SUB_VALIDATORS)['number'][number],
		'between' | 'outside' | 'even' | 'odd'
	>;
	validatorArg: number;
};

type DoubleNumberData = {
	validator: 'number';
	subValidator: Extract<(typeof COMPARE_SUB_VALIDATORS)['number'][number], 'between' | 'outside'>;
	validatorArg: { min: number; max: number };
};

export type CompareData = BooleanData | TextData | NumberData | SingleNumberData | DoubleNumberData;

export type CompateValueType = boolean;

export class Compare extends BaseComponent<CompateValueType> {
	constructor(private readonly data: BaseComponentData & CompareData) {
		super(data, false);
	}

	check(input: never) {
		const validator = this.getValidator();
		this.value = validator(input);
		this.eventEmitter.emit(this.value ? 'true' : 'false', this.value);
	}

	private getValidator() {
		switch (this.data.validator) {
			case 'boolean':
				return (input: unknown) => transformValueToBoolean(input);
			case 'number':
				switch (this.data.subValidator) {
					case 'equal to':
						return (input: unknown) =>
							Number(input) == (this.data.validatorArg as SingleNumberData['validatorArg']);
					case 'greater than':
						return (input: unknown) =>
							Number(input) > (this.data.validatorArg as SingleNumberData['validatorArg']);
					case 'less than':
						return (input: unknown) =>
							Number(input) < (this.data.validatorArg as SingleNumberData['validatorArg']);
					case 'between':
						return (input: unknown) =>
							Number(input) > (this.data.validatorArg as DoubleNumberData['validatorArg']).min &&
							Number(input) < (this.data.validatorArg as DoubleNumberData['validatorArg']).max;
					case 'outside':
						return (input: unknown) =>
							Number(input) < (this.data.validatorArg as DoubleNumberData['validatorArg']).min ||
							Number(input) > (this.data.validatorArg as DoubleNumberData['validatorArg']).max;
					case 'even':
						return (input: unknown) => Math.round(Number(input)) % 2 === 0;
					case 'odd':
						return (input: unknown) => Math.round(Number(input)) % 2 !== 0;
					default:
						return () => false;
				}
			case 'text':
				const expected = this.data.validatorArg as TextData['validatorArg'];
				switch (this.data.subValidator) {
					case 'equal to':
						return (input: unknown) => String(input) === expected;
					case 'including':
						return (input: unknown) => String(input).includes(expected);
					case 'starting with':
						return (input: unknown) => String(input).startsWith(expected);
					case 'ending with':
						return (input: unknown) => String(input).endsWith(expected);
					default:
						return () => false;
				}
			default:
				return () => false;
		}
	}
}
