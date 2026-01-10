import JohnnyFive from 'johnny-five';
import { Hardware } from '../base';
import type { Data, Value } from './relay.types';
import { dataSchema } from './relay.types';

export class Relay extends Hardware<Value, Data, JohnnyFive.Relay> {
	constructor(data: Data) {
		super(dataSchema.parse(data), false);
	}

	open() {
		this.component?.open();
		this.value = true;
	}

	close() {
		this.component?.close();
		this.value = false;
	}

	toggle() {
		this.component?.toggle();
		this.value = !this.value;
	}

	protected createComponent(data: Data) {
		this.component = new JohnnyFive.Relay(data);
		return this.component;
	}
}
