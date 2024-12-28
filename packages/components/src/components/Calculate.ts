import { transformValueToNumber } from '../utils/transformUnknownValues';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type CalculateValueType = number;

export type CalculateData = {
	function: 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo' | keyof typeof Math;
};

export class Calculate extends BaseComponent<CalculateValueType> {
	constructor(private readonly data: BaseComponentData & CalculateData) {
		super(data, 0);
	}

	check(inputs: unknown[]) {
		const inputsAsNumbers = inputs.map(transformValueToNumber);

		const [one, two] = inputsAsNumbers;
		switch (this.data.function) {
			case 'add':
				this.value = one + two;
				break;
			case 'subtract':
				this.value = one - two;
				break;
			case 'multiply':
				this.value = one * two;
				break;
			case 'divide':
				this.value = one / two;
				break;
			case 'modulo':
				this.value = one % two;
				break;
			case 'max':
			case 'min':
			case 'pow':
				this.value = Math[this.data.function](one, two);
				break;
			case 'ceil':
			case 'floor':
			case 'round':
				this.value = Math[this.data.function](one);
				break;
		}
	}
}
