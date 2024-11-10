import JohnnyFive, { LedOption } from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type LedData = Omit<LedOption, 'board'>;
export type LedValueType = number;

type LedOptions = BaseComponentOptions & LedData;

export class Led extends BaseComponent<LedValueType> {
	private readonly component: JohnnyFive.Led;

	constructor(options: LedOptions) {
		super(options, 0);

		this.component = new JohnnyFive.Led(options);
	}

	// Highjack the on method
	// to allow for a custom actions
	on(action: string, callback: (...args: any[]) => void) {
		if (action) {
			this.eventEmitter.on(action, callback);
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
}
