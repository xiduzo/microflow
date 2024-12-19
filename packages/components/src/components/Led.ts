import JohnnyFive, { LedOption } from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type LedData = Omit<LedOption, 'board'>;
export type LedValueType = number;

export class Led extends BaseComponent<LedValueType> {
	private readonly component: JohnnyFive.Led;

	constructor(data: BaseComponentData & LedData) {
		super(data, 0);

		this.component = new JohnnyFive.Led(data);
	}

	// Highjack the on method
	// to allow for a custom actions
	on(action?: unknown, callback?: (...args: any[]) => void) {
		if (typeof action === 'string' && typeof callback === 'function') {
			super.on(action, callback);
			return;
		}

		this.component.on();
		this.value = 1;
	}

	off() {
		this.component.off();
		this.value = 0;
	}

	toggle() {
		this.component.toggle();
		this.value = this.value === 0 ? 1 : 0;
	}

	brightness(value: number) {
		this.component.brightness(value);
		this.value = value;
	}
}
