import JohnnyFive from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type LedOptions = BaseComponentOptions<number> & JohnnyFive.LedOption;

export class Led extends BaseComponent<number> {
	private readonly component: JohnnyFive.Led;
	constructor(private readonly options: LedOptions) {
		super(options);

		this.component = new JohnnyFive.Led(options);

		this.eventEmitter.on('change', this.postMessage.bind(this, 'change'));
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
