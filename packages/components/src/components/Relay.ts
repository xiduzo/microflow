import { BaseComponent, BaseComponentData } from './BaseComponent';

import JohnnyFive, { RelayOption } from 'johnny-five';

export type RelayValueType = boolean;
export type RelayData = Omit<RelayOption, 'board'>;

export class Relay extends BaseComponent<RelayValueType> {
	private readonly component: JohnnyFive.Relay;

	constructor(data: BaseComponentData & RelayData) {
		super(data, false);

		this.component = new JohnnyFive.Relay(data);
	}

	open() {
		this.component.open();
		this.value = true;
	}

	close() {
		this.component.close();
		this.value = false;
	}

	toggle() {
		this.component.toggle();
		this.value = !this.value;
	}
}
