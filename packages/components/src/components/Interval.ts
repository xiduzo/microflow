import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type IntervalOptions = BaseComponentOptions<number> & {
	interval: number;
};

export class Interval extends BaseComponent<number> {
	private readonly minIntervalInMs = 500;
	private interval: NodeJS.Timeout | null = null;

	constructor(private readonly options: IntervalOptions) {
		super(options);

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
