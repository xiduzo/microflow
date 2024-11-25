import Logger from 'electron-log/node';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type CounterData = {};
export type CounterValueType = number;
type CounterOptions = BaseComponentOptions & CounterData;

export class Counter extends BaseComponent<CounterValueType> {
	constructor(options: CounterOptions) {
		super(options, 0);
	}

	// TODO: get value from edge
	increment() {
		try {
			this.value += 1;
		} catch (error) {
			Logger.warn('Invalid value type to increment counter', { error });
			this.postErrorMessage('increment', new Error(`unable to increment`));
		}
	}

	// TODO: get value from edge
	decrement() {
		try {
			this.value -= 1;
		} catch (error) {
			Logger.warn('Invalid value type to decrement counter', { error });
			this.postErrorMessage('decrement', new Error(`unable to decrement`));
		}
	}

	reset() {
		this.value = 0;
	}

	set(value: unknown) {
		try {
			this.value = this.inputToNumber(value);
		} catch (error) {
			Logger.warn('Invalid value type to set counter', { value, error });
			this.postErrorMessage('set', new Error(`${value} is not a valid number`));
		}
	}

	private inputToNumber(input: unknown): number {
		if (typeof input === 'number') {
			return input;
		}

		if (typeof input === 'string') {
			const parsed = parseInt(input, 10);
			if (!isNaN(parsed)) {
				return parsed;
			}
		}

		if (typeof input === 'boolean') {
			return input ? 1 : 0;
		}

		throw new Error('Invalid input type');
	}
}
