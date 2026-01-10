import JohnnyFive from 'johnny-five';
import { Hardware } from '../base';
import { dataSchema, type Data, type Value } from './servo.types';

export class Servo extends Hardware<Value, Data, JohnnyFive.Servo> {
	constructor(data: Data) {
		super(dataSchema.parse(data), 0);
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

	protected createComponent(data: Data) {
		this.component = new JohnnyFive.Servo({
			...data,
			range: [data.range.min, data.range.max],
		});
		return this.component;
	}
}
