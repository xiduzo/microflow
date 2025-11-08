import { Code, BaseComponentData } from './BaseComponent';
import { transformValueToNumber } from '../utils/transformUnknownValues';

export type CounterData = {};
export type CounterValueType = number;

export class Counter extends Code<CounterValueType, CounterData> {
	constructor(data: BaseComponentData & CounterData) {
		super(data, 0);
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
