import { transformValueToBoolean } from '../_utils/transformUnknownValues';
import { Code } from '../base';
import type { Data, Value } from './compare.types';
import { dataSchema } from './compare.types';

export class Compare extends Code<Value, Data> {
	constructor(data: Data) {
		super(dataSchema.parse(data), false);
	}

	check(input: never) {
		const validator = this.getValidator();
		this.value = validator(input);
		this.emit(this.value ? 'true' : 'false', this.value);
	}

	private getValidator() {
		switch (this.data.validator) {
			case 'boolean':
				return (input: unknown) => transformValueToBoolean(input);
			case 'oddEven':
				switch (this.data.subValidator) {
					case 'odd':
						return (input: unknown) => Math.round(Number(input)) % 2 !== 0;
					case 'even':
						return (input: unknown) => Math.round(Number(input)) % 2 === 0;
					default:
						return () => false;
				}
			case 'number':
				const { number } = this.data;
				switch (this.data.subValidator) {
					case 'equal to':
						return (input: unknown) => Number(input) == number;
					case 'greater than':
						return (input: unknown) => Number(input) > number;
					case 'less than':
						return (input: unknown) => Number(input) < number;
					default:
						return () => false;
				}
			case 'range':
				const { range } = this.data;
				switch (this.data.subValidator) {
					case 'between':
						return (input: unknown) => Number(input) > range.min && Number(input) < range.max;
					case 'outside':
						return (input: unknown) => Number(input) < range.min || Number(input) > range.max;
					default:
						return () => false;
				}
			case 'text':
				const { text } = this.data;
				switch (this.data.subValidator) {
					case 'equal to':
						return (input: unknown) => String(input) === text;
					case 'including':
						return (input: unknown) => String(input).includes(text);
					case 'starting with':
						return (input: unknown) => String(input).startsWith(text);
					case 'ending with':
						return (input: unknown) => String(input).endsWith(text);
					default:
						return () => false;
				}
			default:
				return () => false;
		}
	}
}
