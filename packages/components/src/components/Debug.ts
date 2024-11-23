import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type DebugValueType = unknown;

type GraphData = {
	type: 'graph';
	range: { min: number; max: number };
};

type LogData = {
	type: 'log';
	bufferSize: number;
};

export type DebugData = GraphData | LogData;

type DebugOptions = BaseComponentOptions & DebugData;

export class Debug extends BaseComponent<DebugValueType> {
	constructor(options: DebugOptions) {
		super(options, { type: 'number', value: 0 });
	}

	debug(value: unknown) {
		this.value = value;
	}
}
