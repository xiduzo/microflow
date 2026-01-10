import { transformValueToNumber } from '../_utils/transformUnknownValues';
import { Code } from '../base';
import type { Data, Value } from './counter.types';
import { dataSchema } from './counter.types';

export class Counter extends Code<Value, Data> {
	constructor(data: Data) {
		super(dataSchema.parse(data), 0);
	}

	increment() {
		this.value = this.value + 1;
	}

	decrement() {
		this.value = this.value - 1;
	}

	reset() {
		this.value = 0;
	}

	set(value: unknown) {
		this.value = transformValueToNumber(value);
	}
}
