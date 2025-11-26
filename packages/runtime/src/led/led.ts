import JohnnyFive from 'johnny-five';
import { Hardware } from '../base';
import type { Data, Value } from './led.types';
import { dataSchema } from './led.types';

export class Led extends Hardware<Value, Data, JohnnyFive.Led> {
	constructor(data: Data) {
		super(dataSchema.parse(data), 0);
	}

	turnOn() {
		this.component?.on();
		this.value = 1;
	}

	turnOff() {
		this.component?.off();
		this.value = 0;
	}

	toggle() {
		this.component?.toggle();
		this.value = this.value === 0 ? 1 : 0;
	}

	brightness(value: number) {
		this.component?.brightness(value);
		this.value = value;
	}

	protected createComponent(data: Data): JohnnyFive.Led {
		this.component = new JohnnyFive.Led(data);
		return this.component;
	}
}
