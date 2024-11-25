import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type DebugValueType = unknown;

type GraphData = {
	type: 'graph';
	range: { min: number; max: number };
};

type StringData = {
	type: 'string';
	bufferSize: number;
};

type ObjectData = {
	type: 'object';
	multiline: true;
	rows: number;
};

export type DebugData = GraphData | StringData | ObjectData;

type DebugOptions = BaseComponentOptions & DebugData;

export class Debug extends BaseComponent<DebugValueType> {
	constructor(options: DebugOptions) {
		super(options, 0);
	}

	debug(value: unknown) {
		this.value = value;
	}
}
