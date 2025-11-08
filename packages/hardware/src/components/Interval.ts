import { MIN_INTERVAL_IN_MS } from '../constants/Interval';
import { Code, BaseComponentData } from './BaseComponent';

export type IntervalData = {
	interval: number;
	autoStart?: boolean;
};
export type IntervalValueType = number;

export class Interval extends Code<IntervalValueType, IntervalData> {
	private timeout: NodeJS.Timeout | null = null;

	constructor(data: BaseComponentData & IntervalData) {
		super(data, 0);

		if (data.autoStart) this.start();
	}

	start() {
		this.stop();
		this.tick();
	}

	stop() {
		if (this.timeout) clearTimeout(this.timeout);
	}

	private tick() {
		this.timeout = setTimeout(() => {
			this.value = Math.round(performance.now());
			this.tick();
		}, this.getIntervalTime(this.data.interval));
	}

	private getIntervalTime(interval: number) {
		const parsed = parseInt(String(interval));
		const isNumber = !isNaN(parsed);

		if (!isNumber) return MIN_INTERVAL_IN_MS;

		return Math.max(MIN_INTERVAL_IN_MS, parsed);
	}
}
