import JohnnyFive, { LedOption } from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type LedData = Omit<LedOption, 'board'>;
export type LedValueType = number;

export class Led extends BaseComponent<LedValueType, LedData, JohnnyFive.Led> {
	constructor(data: BaseComponentData & LedData) {
		super(data, 0);

		this.createComponent(data);
		this.on('new-data', data => this.createComponent(data as BaseComponentData & LedData));
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

	private createComponent(data: BaseComponentData & LedData) {
		this.component = new JohnnyFive.Led(data);
	}
}
