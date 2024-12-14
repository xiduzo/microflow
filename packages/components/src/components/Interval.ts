import { BaseComponent, BaseComponentData } from './BaseComponent';

export type IntervalData = {
	interval: number;
	autoStart?: boolean;
};
export type IntervalValueType = number;

export class Interval extends BaseComponent<IntervalValueType> {
	private readonly minIntervalInMs = 500;
	private interval: NodeJS.Timeout | null = null;

	constructor(private readonly data: BaseComponentData & IntervalData) {
		super(data, 0);

		this.start();
	}

	private getIntervalTime(interval: number) {
		const parsed = parseInt(String(interval));
		const isNumber = !isNaN(parsed);

		if (!isNumber) {
			return this.minIntervalInMs;
		}

		return Math.max(this.minIntervalInMs, parsed);
	}

	start() {
		if (this.interval) {
			clearInterval(this.interval);
		}

		this.value = Math.round(performance.now());

		this.interval = setInterval(() => {
			this.value = Math.round(performance.now());
		}, this.getIntervalTime(this.data.interval));
	}

	stop() {
		if (this.interval) {
			clearInterval(this.interval);
		}
	}
}
