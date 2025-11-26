import { Code } from '../base';
import type { Data, Value } from './monitor.types';
import { dataSchema } from './monitor.types';

export class Monitor extends Code<Value, Data> {
	constructor(data: Data) {
		super(dataSchema.parse(data), 0);
	}

	debug(value: unknown) {
		this.value = value;
	}
}
