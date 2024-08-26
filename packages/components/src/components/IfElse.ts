import { SubValidator, Validator } from '../constants/IfElse';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type IfElseData = {
	validatorArgs: unknown[];
	validator: Validator;
	subValidator: string;
};
export type IfElseValueType = boolean;

export type IfElseOptions = BaseComponentOptions<boolean> & {
	validator: Validator;
	subValidator?: SubValidator;
	validatorArgs: any[];
};
export type { SubValidator, Validator } from '../constants/IfElse';

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
				const [num1, num2] = this.options.validatorArgs.map(Number);
				switch (this.options.subValidator) {
					case 'equal to':
						return (input: number) => input == num1;
					case 'greater than':
						return (input: number) => input > num1;
					case 'less than':
						return (input: number) => input < num1;
					case 'between':
						return (input: number) => input > num1 && input < num2;
					case 'outside':
						return (input: number) => input < num1 && input > num2;
					case 'is even':
						return (input: number) => Math.round(input) % 2 === 0;
					case 'is odd':
						return (input: number) => Math.round(input) % 2 !== 0;
					default:
						return () => false;
				}
			case 'text':
				const [expected] = this.options.validatorArgs.map(String);
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
