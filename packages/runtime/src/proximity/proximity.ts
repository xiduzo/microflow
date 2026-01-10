import JohnnyFive from 'johnny-five';
import { Hardware } from '../base';
import type { Data, Value } from './proximity.types';
import { dataSchema } from './proximity.types';

export class Proximity extends Hardware<Value, Data, JohnnyFive.Proximity> {
	constructor(data: Data) {
		super(dataSchema.parse(data), 0);
	}

	protected createComponent(data: Data) {
		this.component = new JohnnyFive.Proximity(data);

		this.component.on('data', data => {
			this.value = data.cm;
		});
		return this.component;
	}
}
