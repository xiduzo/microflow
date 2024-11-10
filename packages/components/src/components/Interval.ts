import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type IntervalData = {
	interval: number;
	autoStart?: boolean;
};
export type IntervalValueType = number;

type IntervalOptions = BaseComponentOptions & IntervalData;

export class Interval extends BaseComponent<IntervalValueType> {
	private readonly minIntervalInMs = 500;
	private interval: NodeJS.Timeout | null = null;

	constructor(private readonly options: IntervalOptions) {
		super(options, 0);

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
		}, this.getIntervalTime(this.options.interval));
	}

	stop() {
		if (this.interval) {
			clearInterval(this.interval);
		}
	}
}
