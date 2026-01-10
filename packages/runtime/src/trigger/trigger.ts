import { transformValueToNumber } from '../_utils/transformUnknownValues';
import { Code } from '../base';
import type { Data, Value } from './trigger.types';
import { dataSchema } from './trigger.types';

type ValueWithTimestamp = {
	value: number;
	timestamp: number;
};

export class Trigger extends Code<Value, Data> {
	private history: ValueWithTimestamp[] = [];

	constructor(data: Data) {
		super(dataSchema.parse(data), false);
	}

	signal(value: unknown) {
		const valueAsNumber = transformValueToNumber(value);
		const currentTime = performance.now();

		this.history = this.history.filter(
			({ timestamp }) => currentTime - timestamp <= this.data.within
		);

		this.history.push({ value: valueAsNumber, timestamp: currentTime });

		const shouldBang = this.checkDifference(valueAsNumber);

		if (!shouldBang) return;

		this.emit('bang', valueAsNumber);
	}

	private checkDifference(value: number): boolean {
		const [first] = this.history;
		const difference = value - first.value;
		const correctDirection = this.valueChangesInCorrectDirection(difference);

		if (this.value) {
			this.value = correctDirection;
			return false;
		}

		const reachedThreshold = this.data.relative
			? Math.abs((difference / first.value) * 100) >= this.data.threshold
			: Math.abs(difference) >= this.data.threshold;

		this.value = correctDirection && reachedThreshold;
		return this.value;
	}

	private valueChangesInCorrectDirection(difference: number): boolean {
		const isPositive = difference > 0;

		return this.data.behaviour === 'increasing' ? isPositive : !isPositive;
	}
}
