import JohnnyFive from 'johnny-five';
import { Hardware } from '../base';
import type { Data, Value } from './button.types';
import { dataSchema } from './button.types';

export class Button extends Hardware<Value, Data, JohnnyFive.Button> {
	constructor(data: Data) {
		super(dataSchema.parse(data), false);
	}

	protected createComponent(data: Data) {
		this.component = new JohnnyFive.Button(data);
		this.component.on('up', () => {
			this.value = false;
			this.emit('inactive', this.value);
		});
		this.component.on('down', () => {
			this.value = true;
			this.emit('active', this.value);
		});
		this.component.on('hold', () => {
			this.emit('hold', this.value);
		});
		return this.component;
	}
}
