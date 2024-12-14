import { BaseComponent, BaseComponentOptions } from './BaseComponent';

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

type MonitorOptions = BaseComponentOptions & MonitorData;

export class Monitor extends BaseComponent<DebugValueType> {
	constructor(options: MonitorOptions) {
		super(options, 0);
	}

	debug(value: unknown) {
		this.value = value;
	}
}
