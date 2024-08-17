import JohnnyFive, { ServoGeneralOption } from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type ServoData = Omit<ServoGeneralOption, 'board'>;
export type ServoValueType = number;

type ServoOptions = BaseComponentOptions & ServoData;

export class Servo extends BaseComponent<ServoValueType> {
	private readonly component: JohnnyFive.Servo;

	constructor(private readonly options: ServoOptions) {
		super(options);
		this.component = new JohnnyFive.Servo(options);
	}

	min() {
		this.component.min();
		this.value = this.component.value;
	}

	max() {
		this.component.max();
		this.value = this.component.value;
	}

	to(position: number) {
		if (isNaN(position)) return;

		this.component.to(position);
		this.value = this.component.value;
	}

	rotate(speed = 0) {
		if (typeof speed === 'boolean') {
			speed = speed ? 1 : -1;
		}

		if (speed < 0.05 && speed > -0.05) {
			this.stop();
			return;
		}

		this.component.cw(speed);
		this.value = this.component.value;
	}

	stop() {
		this.component.stop();
		this.value = this.component.value;
	}
}
