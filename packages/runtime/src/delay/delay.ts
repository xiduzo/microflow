import { Code } from '../base';
import type { Data, Value } from './delay.types';
import { dataSchema } from './delay.types';

export class Delay extends Code<Value, Data> {
	private lastTimeout: NodeJS.Timeout | null = null;

	constructor(data: Data) {
		super(dataSchema.parse(data), 0);
	}

	signal(value: number) {
		if (this.data.forgetPrevious && this.lastTimeout) {
			clearTimeout(this.lastTimeout);
		}

		this.lastTimeout = setTimeout(() => {
			this.value = value;
			this.emit('bang', this.value);
		}, this.data.delay);
	}
}
