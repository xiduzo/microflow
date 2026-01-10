import { transformValueToBoolean } from '../_utils/transformUnknownValues';
import { Code } from '../base';
import type { Data, Value } from './gate.types';
import { dataSchema } from './gate.types';

export class Gate extends Code<Value, Data> {
	constructor(data: Data) {
		super(dataSchema.parse(data), false);
	}

	check(inputs: unknown[]) {
		const inputsAsBooleans = inputs.map(transformValueToBoolean);

		this.value = this.passesGate(inputsAsBooleans);

		this.emit(this.value ? 'true' : 'false', this.value);
	}

	private passesGate(inputs: boolean[]) {
		const amountOfTrue = inputs.filter(Boolean).length;
		switch (this.data.gate) {
			case 'and':
				return amountOfTrue === inputs.length;
			case 'nand':
				return amountOfTrue !== inputs.length;
			case 'or':
				return amountOfTrue > 0;
			case 'xor':
				return amountOfTrue === 1;
			case 'nor':
				return amountOfTrue === 0;
			case 'xnor':
				return amountOfTrue !== 1;
			default:
				return false;
		}
	}
}
