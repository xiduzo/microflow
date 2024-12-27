import { BaseComponent, BaseComponentData } from './BaseComponent';

export type TriggerData = {
	relative?: boolean;
	behaviour: 'increasing' | 'decreasing';
	threshold: number;
};

export type TriggerValueType = boolean;

export class Trigger extends BaseComponent<TriggerValueType> {
	private previousValue = Number.NaN; // safe initial value

	constructor(private readonly data: BaseComponentData & TriggerData) {
		super(data, false);
	}

	signal(value: unknown) {
		const valueAsNumber = Number(value);

		const shouldBang = this.checkDifference(valueAsNumber);

		this.previousValue = valueAsNumber;

		if (!shouldBang) return;

		this.eventEmitter.emit('bang', valueAsNumber);
	}

	private checkDifference(value: number): boolean {
		if (isNaN(this.previousValue)) return false;

		const difference = value - this.previousValue;
		const correctDirection = this.valueChangesInCorrectDirection(difference);

		if (this.value) {
			this.value = correctDirection;
			return false;
		}

		const reachedThreshold = this.data.relative
			? Math.abs((difference / this.previousValue) * 100) >= this.data.threshold
			: Math.abs(difference) >= this.data.threshold;

		this.value = correctDirection && reachedThreshold;
		return this.value;
	}

	private valueChangesInCorrectDirection(difference: number): boolean {
		const isPositive = difference > 0;

		return this.data.behaviour === 'increasing' ? isPositive : !isPositive;
	}
}
