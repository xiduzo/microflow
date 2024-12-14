import { BaseComponent, BaseComponentData } from './BaseComponent';

export type DebugValueType = unknown;

type GraphData = {
	type: 'graph';
	range: { min: number; max: number };
};

type RawData = {
	type: 'raw';
	multiline: true;
	rows: number;
};

export type MonitorData = GraphData | RawData;

export class Monitor extends BaseComponent<DebugValueType> {
	constructor(data: BaseComponentData & MonitorData) {
		super(data, 0);
	}

	debug(value: unknown) {
		this.value = value;
	}
}
