import { transformValueToBoolean } from '../_utils/transformUnknownValues';
import { Code } from '../base';
import type { Data, Value } from './hotkey.types';
import { dataSchema } from './hotkey.types';

export class Hotkey extends Code<Value, Data> {
	constructor(data: Data) {
		super(dataSchema.parse(data), false);
	}

	setExternal(value: unknown) {
		this.value = transformValueToBoolean(value);
		this.emit(this.value ? 'pressed' : 'released', this.value);
	}
}
