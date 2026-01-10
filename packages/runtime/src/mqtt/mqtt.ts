import { Code } from '../base';
import type { Data, Value } from './mqtt.types';
import { dataSchema } from './mqtt.types';

export class Mqtt extends Code<Value, Data> {
	constructor(data: Data) {
		super(dataSchema.parse(data), '');
	}

	setExternal(value: string) {
		this.value = value;
		this.emit('subscribe', this.value);
	}

	publish(message: string) {
		this.value = message;
	}
}
