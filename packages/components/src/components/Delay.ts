import { BaseComponent, BaseComponentData } from './BaseComponent';

export type DelayValueType = number;

export type DelayData = {
	delay: number;
};

export class Delay extends BaseComponent<DelayValueType> {
	constructor(private readonly data: BaseComponentData & DelayData) {
		super(data, 0);
	}

	signal(value: number) {
		setTimeout(() => {
			this.value = value;
			this.eventEmitter.emit('bang', this.value);
		}, this.data.delay);
	}
}
