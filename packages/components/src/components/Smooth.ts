import { BaseComponent, BaseComponentData } from './BaseComponent';

export type SmoothData = {
	attenuation: number;
};
export type SmoothValueType = number;

export class Smooth extends BaseComponent<SmoothValueType> {
	private average = 0;

	constructor(private readonly data: BaseComponentData & SmoothData) {
		super(data, 0);
	}

	signal(value: number) {
		this.average = this.data.attenuation * this.average + (1.0 - this.data.attenuation) * value;
		this.value = value - this.average;
	}
}
