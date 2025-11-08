import JohnnyFive, { LedOption } from 'johnny-five';
import { Hardware, BaseComponentData } from './BaseComponent';

export type LedData = Omit<LedOption, 'board'>;
export type LedValueType = number;

export class Led extends Hardware<LedValueType, LedData, JohnnyFive.Led> {
	constructor(data: BaseComponentData & LedData) {
		super(data, 0);
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

	protected createComponent(data: BaseComponentData & LedData): JohnnyFive.Led {
		this.component = new JohnnyFive.Led(data);
		return this.component;
	}
}
