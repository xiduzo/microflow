import { Hardware, BaseComponentData } from './BaseComponent';

import JohnnyFive, { RelayOption } from 'johnny-five';

export type RelayValueType = boolean;
export type RelayData = Omit<RelayOption, 'board'>;

export class Relay extends Hardware<RelayValueType, RelayData, JohnnyFive.Relay> {
	constructor(data: BaseComponentData & RelayData) {
		super(data, false);
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

	protected createComponent(data: BaseComponentData & RelayData) {
		this.component = new JohnnyFive.Relay(data);
		return this.component;
	}
}
