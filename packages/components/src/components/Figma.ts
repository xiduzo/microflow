import { BaseComponent, BaseComponentData } from './BaseComponent';
import { RGBA } from '../types';
import { transformValueToNumber, transformValueToBoolean } from '../utils/transformUnknownValues';

export type FigmaData = {
	variableId?: string;
	resolvedType?: 'FLOAT' | 'STRING' | 'BOOLEAN' | 'COLOR' | undefined;
	initialValue?: FigmaValueType;
	debounceTime?: number;
};
export type FigmaValueType = string | number | boolean | RGBA;

export class Figma extends BaseComponent<FigmaValueType> {
	private readonly defaultRGBA = { r: 0, g: 0, b: 0, a: 1 };

	constructor(private readonly data: BaseComponentData & FigmaData) {
		super(data, data.initialValue ?? '');
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
