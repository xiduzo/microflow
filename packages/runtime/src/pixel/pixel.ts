import { Hardware } from '../base';
import { RGBA } from '../base.types';
import type { Data, Value } from './pixel.types';
import { dataSchema } from './pixel.types';
import pixel from 'node-pixel';

export class Pixel extends Hardware<Value, Data, pixel.Strip> {
	constructor(data: Data) {
		super(dataSchema.parse(data), Array(data.length).fill('#000000'));
	}

	turnOff() {
		this.flush(Array(this.data.length).fill('#000000'));
	}

	color(color: Value | Value[number] | RGBA) {
		if (!Array.isArray(color)) {
			if (typeof color === 'object') color = `rgb(${color.r}, ${color.g}, ${color.b})`;
			return this.colorStrip(color);
		}
		return this.colorPixels(color);
	}

	forward(amount: number = 1) {
		const newValue = this.value.map((_color, index) => {
			const newIndex = index + amount;
			return this.value[newIndex % this.data.length];
		});
		this.component?.shift(amount, pixel.FORWARD, true);
		this.flush(newValue);
	}

	backward(amount: number = 1) {
		const newValue = this.value.map((_color, index) => {
			const newIndex = index - amount;
			return this.value[newIndex % this.data.length];
		});
		this.component?.shift(amount, pixel.BACKWARD, true);
		this.flush(newValue);
	}

	private rgbaToHex(color: RGBA) {
		const redHex = color.r.toString(16).padStart(2, '0');
		const greenHex = color.g.toString(16).padStart(2, '0');
		const blueHex = color.b.toString(16).padStart(2, '0');
		return `#${redHex}${greenHex}${blueHex}`;
	}

	private colorStrip(color: Value[number]) {
		this.component?.color(color);
		this.flush(this.value.map(() => color));
	}

	private colorPixels(color: Value) {
		color.forEach((color, index) => {
			this.component?.pixel(index).color(color);
		});
		this.flush(color);
	}

	private flush(color: Value) {
		this.value = color;
		this.component?.show();
	}

	createComponent(data: Data): pixel.Strip {
		this.component?.shift;
		this.component = new pixel.Strip({
			...data,
			strips: [
				{
					pin: data.pin,
					length: data.length,
				},
			],
			color_order: data.color_order as any,
			board: this.data.board as any,
		});
		this.component.on('ready', () => {
			this.turnOff();
			this.emit('ready');
		});
		return this.component;
	}
}
