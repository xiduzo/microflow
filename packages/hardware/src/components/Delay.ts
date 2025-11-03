import { BaseComponent, BaseComponentData } from './BaseComponent';

export type DelayValueType = number;

export type DelayData = {
	delay: number;
	forgetPrevious: boolean;
};

export class Delay extends BaseComponent<DelayValueType, DelayData> {
	private lastTimeout: NodeJS.Timeout | null = null;

	constructor(data: BaseComponentData & DelayData) {
		super(data, 0);
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
