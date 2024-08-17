import Logger from 'electron-log/node';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type CounterData = {};
export type CounterValueType = number;
type CounterOptions = BaseComponentOptions & CounterData;

export class Counter extends BaseComponent<CounterValueType> {
	constructor(private readonly options: CounterOptions) {
		super(options);
	}

	increment(amount = 1) {
		try {
			this.value += this.inputToNumber(amount);
		} catch (error) {
			Logger.warn('Invalid value type to increment counter', { amount, error });
			this.postErrorMessage(
				'increment',
				new Error(`${amount} is not a valid number`),
			);
		}
	}

	decrement(amount = 1) {
		try {
			this.value -= this.inputToNumber(amount);
		} catch (error) {
			Logger.warn('Invalid value type to decrement counter', { amount, error });
			this.postErrorMessage(
				'decrement',
				new Error(`${amount} is not a valid number`),
			);
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
