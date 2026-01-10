import { Code } from '../base';
import type { Data, Value } from './rangemap.types';
import { dataSchema } from './rangemap.types';

export class RangeMap extends Code<Value, Data> {
	constructor(data: Data) {
		super(dataSchema.parse(data), [0, 0]);
	}

	from(input: boolean | string | number) {
		if (typeof input === 'boolean') {
			input = input ? 1 : 0;
		}

		if (typeof input === 'string') {
			input = parseFloat(input);
		}

		const { min: inMin = 0, max: inMax = 1023 } = this.data.from;
		const { min: outMin = 0, max: outMax = 1023 } = this.data.to;

		const mapped = ((input - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
		const distance = outMax - outMin;
		const normalizedOutput = parseFloat(mapped.toFixed(distance <= 10 ? 1 : 0));

		this.emit('to', normalizedOutput);

		this.value = [input, normalizedOutput];
	}
}
