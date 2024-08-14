import Logger from 'electron-log/node';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type FigmaOptions = BaseComponentOptions<string>;

type RGBA = {
	r: number;
	g: number;
	b: number;
	a: number;
};

export class Figma extends BaseComponent<string | number | boolean | RGBA> {
	private readonly defaultRGBA = { r: 0, g: 0, b: 0, a: 1 };

	constructor(public readonly options: FigmaOptions) {
		super(options);
	}

	increment(amount = 1) {
		this.value = Number(this.value) + amount;
	}

	decrement(amount = 1) {
		this.value = Number(this.value) - amount;
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

	set(value: string | number | boolean | RGBA) {
		try {
			switch (typeof this.value) {
				case 'string':
					this.value = String(value ?? '-');
					break;
				case 'number':
					const num = Number(value);
					if (isNaN(num)) {
						throw new Error('Invalid number');
					}
					this.value = this.formatNumberWithMaxDecimals(num);
					break;
				case 'boolean':
					this.value = Boolean(value);
					break;
				case 'object':
					const convertedValue = this.convertValue(value);
					if (typeof convertedValue !== 'object') {
						throw new Error('Invalid object');
					}
					this.value = convertedValue;
					break;
			}
		} catch (error) {
			Logger.warn('Invalid value type to set figma', { value, error });
			this.postErrorMessage('set', new Error(`${value} is not a valid value`));
		}
	}

	setExternal(value: string | number | boolean | RGBA) {
		this.value = this.convertValue(value);
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
		if (typeof value === 'object') {
			const obj = { ...this.defaultRGBA, ...value };
			return {
				r: this.formatNumberWithMaxDecimals(obj.r),
				g: this.formatNumberWithMaxDecimals(obj.g),
				b: this.formatNumberWithMaxDecimals(obj.b),
				a: this.formatNumberWithMaxDecimals(obj.a),
			};
		}

		if (typeof value === 'number') {
			return this.formatNumberWithMaxDecimals(value);
		}

		if (typeof value === 'boolean') {
			return value;
		}

		if (typeof value === 'string') {
			return value ?? '-';
		}

		throw new Error('Invalid value type');
	}
}
