import { BaseComponent, BaseComponentData } from './BaseComponent';

import JohnnyFive, { RelayOption } from 'johnny-five';

export type RelayValueType = boolean;
export type RelayData = Omit<RelayOption, 'board'>;

export class Relay extends BaseComponent<RelayValueType, RelayData, JohnnyFive.Relay> {
	constructor(data: BaseComponentData & RelayData) {
		super(data, false);

		this.createComponent(data);
		this.on('new-data', data => this.createComponent(data as BaseComponentData & RelayData));
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

	private createComponent(data: BaseComponentData & RelayData) {
		this.component = new JohnnyFive.Relay(data);
	}
}
