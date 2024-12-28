import Logger from 'electron-log/node';
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
		try {
			this.value = this.value + 1;
		} catch (error) {
			Logger.warn('Invalid value type to increment counter', { error });
			this.postErrorMessage('increment', new Error(`unable to increment`));
		}
	}

	// TODO: get value from edge
	decrement() {
		try {
			this.value = this.value - 1;
		} catch (error) {
			Logger.warn('Invalid value type to decrement counter', { error });
			this.postErrorMessage('decrement', new Error(`unable to decrement`));
		}
	}

	reset() {
		this.value = 0;
	}

	set(value: unknown) {
		this.value = transformValueToNumber(value);
	}
}
