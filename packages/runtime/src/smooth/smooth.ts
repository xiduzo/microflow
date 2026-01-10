import { transformValueToNumber } from '../_utils/transformUnknownValues';
import { Code } from '../base';
import type { Data, Value } from './smooth.types';
import { dataSchema } from './smooth.types';

export class Smooth extends Code<Value, Data> {
	private history: number[] = [];

	constructor(data: Data) {
		super(dataSchema.parse(data), 0);
	}

	signal(value: unknown) {
		const valueAsNumber = transformValueToNumber(value);

		switch (this.data.type) {
			case 'movingAverage':
				this.movingAverage(valueAsNumber, this.data.windowSize);
				break;
			case 'smooth':
				this.smooth(valueAsNumber, this.data.attenuation);
				break;
		}
	}

	private smooth(value: number, attenuation: number) {
		this.value = attenuation * value + (1.0 - attenuation) * this.value;
	}

	private movingAverage(value: number, windowSize: number) {
		this.history.push(value);

		if (this.history.length > windowSize) {
			this.history.shift();
		}

		this.value = this.history.reduce((acc, val) => acc + val, 0) / this.history.length;
	}
}
