import { BaseComponent, BaseComponentOptions } from './BaseComponent';

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
	/**
	 * To work nicely with the tweakplane UI, we need to have a single object with x and y properties.
	 */
	validatorArg: { x: number; y: number };
};

export type IfElseData = BooleanData | TextData | NumberData | SingleNumberData | DoubleNumberData;

export type IfElseValueType = boolean;

export type IfElseOptions = BaseComponentOptions<boolean> & IfElseData;

export class IfElse extends BaseComponent<IfElseValueType> {
	constructor(private readonly options: IfElseOptions) {
		super(options);
	}

	check(input: never) {
		const validator = this.#validator();
		this.value = validator(input);
		this.eventEmitter.emit(this.value ? 'true' : 'false', this.value, false);
	}

	#validator() {
		switch (this.options.validator) {
			case 'boolean':
				return (input: boolean | string) =>
					input === true || ['1', 'true', 'on', 'yes'].includes(String(input).toLowerCase());
			case 'number':
				switch (this.options.subValidator) {
					case 'equal to':
						return (input: number) =>
							input == (this.options.validatorArg as SingleNumberData['validatorArg']);
					case 'greater than':
						return (input: number) =>
							input > (this.options.validatorArg as SingleNumberData['validatorArg']);
					case 'less than':
						return (input: number) =>
							input < (this.options.validatorArg as SingleNumberData['validatorArg']);
					case 'between':
						return (input: number) =>
							input > (this.options.validatorArg as DoubleNumberData['validatorArg']).x &&
							input < (this.options.validatorArg as DoubleNumberData['validatorArg']).y;
					case 'outside':
						return (input: number) =>
							input < (this.options.validatorArg as DoubleNumberData['validatorArg']).x &&
							input > (this.options.validatorArg as DoubleNumberData['validatorArg']).y;
					case 'even':
						return (input: number) => Math.round(input) % 2 === 0;
					case 'odd':
						return (input: number) => Math.round(input) % 2 !== 0;
					default:
						return () => false;
				}
			case 'text':
				const expected = this.options.validatorArg as TextData['validatorArg'];
				switch (this.options.subValidator) {
					case 'equal to':
						return (input: string) => input === expected;
					case 'includes':
						return (input: string) => input.includes(expected);
					case 'starts with':
						return (input: string) => input.startsWith(expected);
					case 'ends with':
						return (input: string) => input.endsWith(expected);
					default:
						return () => false;
				}
			default:
				return () => false;
		}
	}
}
