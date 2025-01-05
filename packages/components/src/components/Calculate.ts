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

		switch (this.data.function) {
			case 'add':
				this.value = inputsAsNumbers.reduce((acc, val) => acc + val, 0);
				break;
			case 'subtract':
				this.value = inputsAsNumbers.reduce((acc, val) => acc - val, 0);
				break;
			case 'multiply':
				this.value = inputsAsNumbers.reduce((acc, val) => acc * val, 1);
				break;
			case 'divide':
				this.value = inputsAsNumbers.reduce((acc, val) => acc / val, 1);
				break;
			case 'modulo':
				this.value = inputsAsNumbers.reduce((acc, val) => acc % val, 0);
				break;
			case 'max':
			case 'min':
				this.value = Math[this.data.function](...inputsAsNumbers);
				break;
			case 'pow':
				this.value = Math[this.data.function](inputsAsNumbers[0], inputsAsNumbers[1]);
				break;
			case 'ceil':
			case 'floor':
			case 'round':
				this.value = Math[this.data.function](inputsAsNumbers[0]);
				break;
		}
	}
}
