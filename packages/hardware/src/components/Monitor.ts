import { Code, BaseComponentData } from './BaseComponent';

export type DebugValueType = unknown;

export type MonitorData = {
	type: 'graph' | 'raw';
	fps: number;
};

export class Monitor extends Code<DebugValueType, MonitorData> {
	constructor(data: BaseComponentData & MonitorData) {
		super(data, 0);
	}

	debug(value: unknown) {
		this.value = value;
	}
}
