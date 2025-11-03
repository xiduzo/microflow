import { transformValueToNumber } from '../utils/transformUnknownValues';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type TriggerData = {
	relative?: boolean;
	behaviour: 'increasing' | 'decreasing';
	threshold: number;
	within: number;
};

export type TriggerValueType = boolean;

type ValueWithTimestamp = {
	value: number;
	timestamp: number;
};

export class Trigger extends BaseComponent<TriggerValueType, TriggerData> {
	private history: ValueWithTimestamp[] = [];

	constructor(data: BaseComponentData & TriggerData) {
		super(data, false);
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
