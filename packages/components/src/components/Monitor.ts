import { BaseComponent, BaseComponentData } from './BaseComponent';

export type DebugValueType = unknown;

export type MonitorData = {
	type: 'graph' | 'raw';
};

export class Monitor extends BaseComponent<DebugValueType> {
	constructor(data: BaseComponentData & MonitorData) {
		super(data, 0);
	}

	debug(value: unknown) {
		this.value = value;
	}
}
