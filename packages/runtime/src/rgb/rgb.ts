import JohnnyFive from 'johnny-five';
import { Hardware } from '../base';
import { RGBA } from '../base.types';
import type { Data, Value } from './rgb.types';
import { dataSchema } from './rgb.types';

export class Rgb extends Hardware<Value, Data, JohnnyFive.Led.RGB> {
	private updateQueue: Promise<void> = Promise.resolve();

	constructor(data: Data) {
		super(dataSchema.parse(data), { r: 0, g: 0, b: 0, a: 1 });
	}

	red(value: number) {
		this.enqueueUpdate(() => {
			this.setColor({ ...this.value, r: this.capValue(value) });
		});
	}

	green(value: number) {
		this.enqueueUpdate(() => {
			this.setColor({ ...this.value, g: this.capValue(value) });
		});
	}

	blue(value: number) {
		this.enqueueUpdate(() => {
			this.setColor({ ...this.value, b: this.capValue(value) });
		});
	}

	alpha(value: number) {
		this.enqueueUpdate(() => {
			value = this.capValue(value, 100) / 100;
			this.component?.intensity(value);
			this.setColor({ ...this.value, a: value });
		});
	}

	private capValue(value: number, max: number = 255) {
		return Math.min(Math.max(value, 0), max);
	}

	private enqueueUpdate(updateFn: () => void) {
		this.updateQueue = this.updateQueue.then(
			() =>
				new Promise<void>(resolve => {
					updateFn();
					resolve();
				})
		);
	}

	private setColor(data: RGBA) {
		this.component?.color(this.convertToHex(data));
		this.value = data;
	}

	private convertToHex(data: RGBA) {
		const redHex = data.r.toString(16).padStart(2, '0');
		const greenHex = data.g.toString(16).padStart(2, '0');
		const blueHex = data.b.toString(16).padStart(2, '0');
		return `#${redHex}${greenHex}${blueHex}`;
	}

	protected createComponent(data: Data) {
		this.component = new JohnnyFive.Led.RGB(data);
		return this.component;
	}
}
