import JohnnyFive from 'johnny-five';
import { Hardware, BaseComponentData } from './BaseComponent';
import { RGBA } from '../types';

export type RgbData = Omit<ConstructorParameters<typeof JohnnyFive.Led.RGB>[0], 'board'>;

export type RgbValueType = RGBA;

export class Rgb extends Hardware<RgbValueType, RgbData, JohnnyFive.Led.RGB> {
	private updateQueue: Promise<void> = Promise.resolve();

	constructor(data: BaseComponentData & RgbData) {
		super(data, { r: 0, g: 0, b: 0, a: 1 });
	}

	red(value: number) {
		this.enqueueUpdate(() => {
			this.setColor({ ...this.value, r: Math.min(value, 255) });
		});
	}

	green(value: number) {
		this.enqueueUpdate(() => {
			this.setColor({ ...this.value, g: Math.min(value, 255) });
		});
	}

	blue(value: number) {
		this.enqueueUpdate(() => {
			this.setColor({ ...this.value, b: Math.min(value, 255) });
		});
	}

	alpha(value: number) {
		this.enqueueUpdate(() => {
			this.component?.intensity(value);
			this.setColor({ ...this.value, a: Math.min(value / 100, 1) });
		});
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

	protected createComponent(data: BaseComponentData & RgbData) {
		this.component = new JohnnyFive.Led.RGB(data);
		return this.component;
	}
}
