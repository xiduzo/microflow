import { MIN_INTERVAL_IN_MS } from '../constants/Interval';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type IntervalData = {
	interval: number;
	autoStart?: boolean;
};
export type IntervalValueType = number;

export class Interval extends BaseComponent<IntervalValueType> {
	private interval: NodeJS.Timeout | null = null;

	constructor(private readonly data: BaseComponentData & IntervalData) {
		super(data, 0);

		this.start();
	}

	start() {
		this.stop();

		this.value = Math.round(performance.now());

		this.interval = setInterval(() => {
			this.value = Math.round(performance.now());
		}, this.getIntervalTime(this.data.interval));
	}

	stop() {
		if (this.interval) clearInterval(this.interval);
	}

	private getIntervalTime(interval: number) {
		const parsed = parseInt(String(interval));
		const isNumber = !isNaN(parsed);

		if (!isNumber) return MIN_INTERVAL_IN_MS;

		return Math.max(MIN_INTERVAL_IN_MS, parsed);
	}
}
