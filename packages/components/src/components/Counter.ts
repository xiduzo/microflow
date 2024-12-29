import { BaseComponent, BaseComponentData } from './BaseComponent';
import { transformValueToNumber } from '../utils/transformUnknownValues';

export type CounterData = {};
export type CounterValueType = number;

export class Counter extends BaseComponent<CounterValueType> {
	constructor(data: BaseComponentData & CounterData) {
		super(data, 0);
	}

	// TODO: get value from edge
	increment() {
		this.value = this.value + 1;
	}

	// TODO: get value from edge
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
