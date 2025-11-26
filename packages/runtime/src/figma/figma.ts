import { Code } from '../base';
import { transformValueToNumber, transformValueToBoolean } from '../_utils/transformUnknownValues';
import type { Data, Value } from './figma.types';
import { dataSchema } from './figma.types';
import { type RGBA } from '../base.types';

export class Figma extends Code<Value, Data> {
	private readonly defaultRGBA: RGBA = { r: 0, g: 0, b: 0, a: 1 };

	constructor(data: Data) {
		super(dataSchema.parse(data), data.initialValue ?? '');
	}

	increment() {
		this.value = Number(this.value) + 1;
	}

	decrement() {
		this.value = Number(this.value) - 1;
	}

	true() {
		this.value = true;
	}

	false() {
		this.value = false;
	}

	toggle() {
		this.value = !Boolean(this.value);
	}

	set(value: unknown) {
		this.convertValue(value);
	}

	reset() {
		switch (this.data.resolvedType) {
			case 'BOOLEAN':
				this.value = false;
				break;
			case 'FLOAT':
				this.value = 0;
				break;
			case 'STRING':
				this.value = '';
				break;
			case 'COLOR':
				this.value = { r: 0, g: 0, b: 0, a: 0 };
				break;
		}
	}

	setExternal(value: unknown) {
		this.convertValue(value);
	}

	red(value: number) {
		const currentValue = typeof this.value === 'object' ? this.value : {};
		this.value = {
			...this.defaultRGBA,
			...currentValue,
			r: this.formatNumberWithMaxDecimals(Math.min(1, value / 255)),
		};
	}

	green(value: number) {
		const currentValue = typeof this.value === 'object' ? this.value : {};
		this.value = {
			...this.defaultRGBA,
			...currentValue,
			g: this.formatNumberWithMaxDecimals(Math.min(1, value / 255)),
		};
	}

	blue(value: number) {
		const currentValue = typeof this.value === 'object' ? this.value : {};
		this.value = {
			...this.defaultRGBA,
			...currentValue,
			b: this.formatNumberWithMaxDecimals(Math.min(1, value / 255)),
		};
	}

	opacity(value: number) {
		const currentValue = typeof this.value === 'object' ? this.value : {};
		this.value = {
			...this.defaultRGBA,
			...currentValue,
			a: this.formatNumberWithMaxDecimals(Math.min(1, value / 100)),
		};
	}

	private formatNumberWithMaxDecimals(value: number) {
		return Number(value.toFixed(2));
	}

	private convertValue(value: unknown) {
		switch (this.data.resolvedType) {
			case 'BOOLEAN':
				this.value = transformValueToBoolean(value);
				this.emit(this.value ? 'true' : 'false', this.value);
				break;
			case 'FLOAT':
				this.value = transformValueToNumber(value);
				break;
			case 'STRING':
				this.value = String(value);
				break;
			case 'COLOR':
				if (typeof value === 'object') {
					const obj = { ...this.defaultRGBA, ...value };
					this.value = {
						r: this.formatNumberWithMaxDecimals(obj.r),
						g: this.formatNumberWithMaxDecimals(obj.g),
						b: this.formatNumberWithMaxDecimals(obj.b),
						a: this.formatNumberWithMaxDecimals(obj.a),
					};
					return;
				}

				this.value = { r: 0, g: 0, b: 0, a: 0 };
				break;
		}
	}
}
