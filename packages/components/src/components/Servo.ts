import JohnnyFive from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type ServoOptions = BaseComponentOptions<number> &
	JohnnyFive.ServoGeneralOption;

export class Servo extends BaseComponent<number> {
	private readonly component: JohnnyFive.Servo;

	constructor(private readonly options: ServoOptions) {
		super(options);
		this.component = new JohnnyFive.Servo(options);

		this.component.on('move:complete', this.postMessage.bind(this, 'complete'));
	}

	min() {
		this.component.min();
		this.postMessage('change');
	}

	max() {
		this.component.max();
		this.postMessage('change');
	}

	to(position: number) {
		if (isNaN(position)) return;

		this.component.to(position);
		this.postMessage('change');
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

		this.postMessage('change');
	}

	stop() {
		this.component.stop();
		this.postMessage('change');
	}
}
