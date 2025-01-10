import { transformValueToNumber } from '../utils/transformUnknownValues';
import { BaseComponent, BaseComponentData } from './BaseComponent';

type SmoothAverage = {
	type: 'smooth';
	attenuation: number;
};

type MovingAverage = {
	type: 'movingAverage';
	windowSize: number;
};

export type SmoothData = SmoothAverage | MovingAverage;

export type SmoothValueType = number;

export class Smooth extends BaseComponent<SmoothValueType> {
	private history: number[] = [];

	constructor(private readonly data: BaseComponentData & SmoothData) {
		super(data, 0);
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
