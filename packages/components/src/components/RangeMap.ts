import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type Range = { min: number; max: number };
export type RangeMapData = {
	from: Range;
	to: Range;
};
export type RangeMapValueType = [number, number];

type RangeMapOptions = BaseComponentOptions & RangeMapData;

export class RangeMap extends BaseComponent<RangeMapValueType> {
	constructor(private readonly options: RangeMapOptions) {
		super(options, [0, 0]);
	}

	from(input: boolean | string | number) {
		if (typeof input === 'boolean') {
			input = input ? 1 : 0;
		}

		if (typeof input === 'string') {
			input = parseFloat(input);
		}

		const { min: inMin = 0, max: inMax = 1023 } = this.options.from;
		const { min: outMin = 0, max: outMax = 1023 } = this.options.to;

		const mapped = ((input - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
		const distance = outMax - outMin;
		const normalizedOutput = parseFloat(mapped.toFixed(distance <= 10 ? 1 : 0));

		const prevValue = this.value;
		this.value = [input, normalizedOutput];

		if (prevValue[1] !== normalizedOutput) {
			this.eventEmitter.emit('to', normalizedOutput, false);
		}
	}
}
