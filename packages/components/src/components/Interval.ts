import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type IntervalOptions = BaseComponentOptions<number> & {
	interval: number;
};

export class Interval extends BaseComponent<number> {
	private readonly minIntervalInMs = 500;

	constructor(private readonly options: IntervalOptions) {
		super(options);

		setInterval(() => {
			this.value = Math.round(performance.now());
		}, this.interval(options.interval));
	}

	private interval(interval: number) {
		const parsed = parseInt(String(interval));
		const isNumber = !isNaN(parsed);

		if (!isNumber) {
			return this.minIntervalInMs;
		}

		return Math.max(this.minIntervalInMs, parsed);
	}
}
