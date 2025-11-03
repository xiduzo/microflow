import { BaseComponent, BaseComponentData } from './BaseComponent';

export type DebugValueType = unknown;

export type MonitorData = {
	type: 'graph' | 'raw';
	fps: number;
};

export class Monitor extends BaseComponent<DebugValueType, MonitorData> {
	constructor(data: BaseComponentData & MonitorData) {
		super(data, 0);
	}

	debug(value: unknown) {
		this.value = value;
	}
}
