import { transformValueToNumber } from '../_utils/transformUnknownValues';
import { Code } from '../base';
import type { Data, Value } from './calculate.types';
import { dataSchema } from './calculate.types';

export class Calculate extends Code<Value, Data> {
	constructor(data: Data) {
		super(dataSchema.parse(data), 0);
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
