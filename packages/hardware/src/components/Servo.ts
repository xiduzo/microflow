import JohnnyFive, { ServoGeneralOption } from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type ServoData = Omit<ServoGeneralOption, 'board' | 'range'> & {
	range: { min: number; max: number };
};
export type ServoValueType = number;

export class Servo extends BaseComponent<ServoValueType, ServoData, JohnnyFive.Servo> {
	constructor(data: BaseComponentData & ServoData) {
		super(data, 0);

		this.createComponent(data);
		this.on('new-data', data => this.createComponent(data as BaseComponentData & ServoData));
	}

	min() {
		this.component?.min();
		this.value = Number(this.component?.value ?? 0);
	}

	max() {
		this.component?.max();
		this.value = Number(this.component?.value ?? 0);
	}

	to(position: number) {
		if (isNaN(position)) return;

		this.component?.to(position);
		this.value = Number(this.component?.value ?? 0);
	}

	rotate(speed: number | string | boolean = 0) {
		if (typeof speed === 'boolean') {
			speed = speed ? 1 : -1;
		}

		speed = Number(speed);

		if (speed < 0.05 && speed > -0.05) {
			this.stop();
			return;
		}

		this.component?.cw(speed);
		this.value = Number(speed);
	}

	stop() {
		this.component?.stop();
		this.value = this.component?.value ?? 0;
	}

	private createComponent(data: BaseComponentData & ServoData) {
		this.component = new JohnnyFive.Servo({
			...data,
			range: [data.range.min, data.range.max],
		});
	}
}
