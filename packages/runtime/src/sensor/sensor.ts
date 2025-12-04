import JohnnyFive from 'johnny-five';
import { Hardware } from '../base';
import type { Data, Value } from './sensor.types';
import { dataSchema } from './sensor.types';

export class Sensor extends Hardware<Value, Data, JohnnyFive.Sensor> {
	constructor(data: Data) {
		super(dataSchema.parse(data), 0);
	}

	protected createComponent(data: Data) {
		this.component = new JohnnyFive.Sensor(data);
		this.component.on('change', () => {
			this.value = Number(this.component.raw);
		});
		return this.component;
	}
}
