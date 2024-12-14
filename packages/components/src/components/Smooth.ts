import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type SmoothData = {
	attenuation: number;
};
export type SmoothValueType = number;

type SmoothOptions = BaseComponentOptions & SmoothData;

export class Smooth extends BaseComponent<SmoothValueType> {
	private average = 0;

	constructor(private readonly options: SmoothOptions) {
		super(options, 0);
	}

	signal(value: number) {
		this.average =
			this.options.attenuation * this.average + (1.0 - this.options.attenuation) * value;
		this.value = value - this.average;
	}
}
