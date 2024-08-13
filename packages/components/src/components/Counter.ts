import Logger from 'electron-log/node';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type CounterOptions = BaseComponentOptions<number>;

export class Counter extends BaseComponent<number> {
	constructor(private readonly options: CounterOptions) {
		super(options);
	}

	increment(amount = 1) {
		try {
			this.value += this.inputToNumber(amount);
		} catch (error) {
			Logger.warn('Invalid value type to increment counter', { amount });
		}
	}

	decrement(amount = 1) {
		try {
			this.value -= this.inputToNumber(amount);
		} catch (error) {
			Logger.warn('Invalid value type to decrement counter', { amount });
		}
	}

	reset() {
		this.value = 0;
	}

	set(value: unknown) {
		try {
			this.value = this.inputToNumber(value);
		} catch (error) {
			Logger.warn('Invalid value type to set counter', { value });
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

		throw new Error('Invalid value type to decrement counter');
	}
}
