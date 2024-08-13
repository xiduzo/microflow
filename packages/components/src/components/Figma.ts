import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type FigmaOptions = BaseComponentOptions<string>;

type RGBA = {
	r: number;
	g: number;
	b: number;
	a: number;
};

export class Figma extends BaseComponent<string | number | boolean | RGBA> {
	private readonly defaultRGBA = { r: 0, g: 0, b: 0, a: 0 };

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

	set(value: string | number | boolean) {
		this.value = value;
	}

	setExternal(value: string | number | boolean) {
		this.value = value;
	}

	red(value: number) {
		const currentValue = typeof this.value === 'object' ? this.value : {};
		this.value = {
			...this.defaultRGBA,
			...currentValue,
			r: Math.min(1, value / 255),
		};
	}

	green(value: number) {
		const currentValue = typeof this.value === 'object' ? this.value : {};
		this.value = {
			...this.defaultRGBA,
			...currentValue,
			g: Math.min(1, value / 255),
		};
	}

	blue(value: number) {
		const currentValue = typeof this.value === 'object' ? this.value : {};
		this.value = {
			...this.defaultRGBA,
			...currentValue,
			b: Math.min(1, value / 255),
		};
	}

	opacity(value: number) {
		const currentValue = typeof this.value === 'object' ? this.value : {};
		this.value = {
			...this.defaultRGBA,
			...currentValue,
			a: Math.min(1, value / 100),
		};
	}
}
