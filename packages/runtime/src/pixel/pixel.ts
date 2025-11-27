import { Hardware } from '../base';
import type { Data, Value } from './pixel.types';
import { dataSchema } from './pixel.types';
import pixel from 'node-pixel';

export class Pixel extends Hardware<Value, Data, pixel.Strip> {
	private isReady = false;
	constructor(data: Data) {
		super(dataSchema.parse(data), Array(data.length).fill('#000000'));
	}

	color(color: Value | Value[number]) {
		if (!this.isReady) return;
		if (!Array.isArray(color)) return this.colorStrip(color);
		return this.colorPixels(color);
	}

	forward(amount: number = 1) {
		this.component?.shift(amount, pixel.FORWARD, true);
	}

	backward(amount: number = 1) {
		this.component?.shift(amount, pixel.BACKWARD, true);
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
					pin: data.data,
					length: data.length,
				},
			],
			color_order: data.color_order as any,
			board: this.data.board as any,
		});
		this.component.on('ready', () => {
			this.isReady = true;
			this.emit('ready');
		});
		return this.component;
	}
}
