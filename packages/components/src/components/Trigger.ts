import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type TriggerBehaviour = 'increasing' | 'exact' | 'decreasing';

export type TriggerData = {
	behaviour: TriggerBehaviour;
	threshold: number;
	duration: number;
};
export type TriggerValueType = number;

type TriggerOptions = BaseComponentOptions & TriggerData;

export class Trigger extends BaseComponent<TriggerValueType> {
	private previousValue: number = Number.NaN; // safe initial value
	private firstDerivative: number = Number.NaN;
	private thresholdCrossed: boolean = false;

	constructor(private readonly options: TriggerOptions) {
		super(options, 0);
	}

	checkIncreasing(value: number): boolean {
		if (this.thresholdCrossed) {
			this.firstDerivative = value - this.previousValue;

			// is decreasing
			if (this.firstDerivative < 0) {
				this.thresholdCrossed = false; // reset when decreasing
			}

			this.previousValue = value;
			return false;
		}

		if (this.previousValue !== Number.NaN) {
			this.firstDerivative = value - this.previousValue;

			// is increasing
			if (this.firstDerivative > 0) {
				if (value >= this.options.threshold) {
					this.thresholdCrossed = true;
				}
			}
		}

		this.previousValue = value;
		return this.thresholdCrossed;
	}

	checkDecreasing(value: number): boolean {
		if (this.thresholdCrossed) {
			this.firstDerivative = value - this.previousValue;

			// is increasing
			if (this.firstDerivative > 0) {
				this.thresholdCrossed = false; // reset when decreasing
			}

			this.previousValue = value;
			return false;
		}

		if (this.previousValue !== Number.NaN) {
			this.firstDerivative = value - this.previousValue;

			// is decreasing
			if (this.firstDerivative < 0) {
				if (value <= this.options.threshold) {
					this.thresholdCrossed = true;
				}
			}
		}

		this.previousValue = value;
		return this.thresholdCrossed;
	}

	signal(value: number) {
		let retval: boolean = false;

		// console.log(
		// 	`style:  ${this.options.behaviour} / thresh: ${this.options.threshold} / fd: ${this.firstDerivative}  / prev: ${this.previousValue}  / crossed: ${this.thresholdCrossed}`,
		// );

		switch (this.options.behaviour) {
			case 'increasing': {
				retval = this.checkIncreasing(Number(value));
				//console.log(`[>] trigger ${this.value} < ${value}`);
				break;
			}
			case 'exact': {
				retval = this.value === Number(value);
				//console.log(`[=] trigger  ${this.value} = ${value}`);
				break;
			}
			case 'decreasing': {
				retval = this.checkDecreasing(Number(value)); //this.value > value ? true : false;
				//console.log(`[<] trigger  ${this.value} > ${value}`);
				break;
			}
		}

		this.value = Number(value);

		if (!retval) return;

		this.eventEmitter.emit('bang', this.value);
	} // input()
} // Trigger component
