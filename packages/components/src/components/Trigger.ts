import { BaseComponent, BaseComponentData } from './BaseComponent';

export type TriggerData = {
	relative?: boolean;
	behaviour: 'increasing' | 'decreasing';
	threshold: number;
};

export type TriggerValueType = number;

export class Trigger extends BaseComponent<TriggerValueType> {
	private previousValue = Number.NaN; // safe initial value
	private thresholdCrossed = false;

	constructor(private readonly data: BaseComponentData & TriggerData) {
		super(data, 0);
	}

	signal(value: number) {
		this.value = Number(value);

		const shouldBang = this.checkDifference(this.value);

		this.previousValue = this.value;

		if (!shouldBang) return;

		this.eventEmitter.emit('bang', this.value);
	}

	private checkDifference(value: number): boolean {
		if (isNaN(this.previousValue)) return false;

		const difference = value - this.previousValue;
		const correctDirection = this.valueChangesInCorrectDirection(difference);

		if (this.thresholdCrossed) {
			this.thresholdCrossed = correctDirection;
			return false;
		}

		const reachedThreshold = this.data.relative
			? Math.abs((difference / this.previousValue) * 100) >= this.data.threshold
			: Math.abs(difference) >= this.data.threshold;

		this.thresholdCrossed = correctDirection && reachedThreshold;

		return this.thresholdCrossed;
	}

	private valueChangesInCorrectDirection(difference: number): boolean {
		const isPositive = difference > 0;

		return this.data.behaviour === 'increasing' ? isPositive : !isPositive;
	}
}
