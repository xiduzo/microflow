import { transformValueToBoolean } from '../utils/transformValueToBoolean';
import { BaseComponent, BaseComponentData } from './BaseComponent';

type BooleanData = {
	validator: 'boolean';
	subValidator?: never;
	validatorArg?: never;
};

type TextData = {
	validator: 'text';
	subValidator: 'equal to' | 'includes' | 'starts with' | 'ends with';
	validatorArg: string;
};

type NumberData = {
	validator: 'number';
	subValidator: 'even' | 'odd';
	validatorArg: never;
};

type SingleNumberData = {
	validator: 'number';
	subValidator: 'equal to' | 'greater than' | 'less than';
	validatorArg: number;
};

type DoubleNumberData = {
	validator: 'number';
	subValidator: 'between' | 'outside';
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
							Number(input) < (this.data.validatorArg as DoubleNumberData['validatorArg']).min &&
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
					case 'includes':
						return (input: unknown) => String(input).includes(expected);
					case 'starts with':
						return (input: unknown) => String(input).startsWith(expected);
					case 'ends with':
						return (input: unknown) => String(input).endsWith(expected);
					default:
						return () => false;
				}
			default:
				return () => false;
		}
	}
}
