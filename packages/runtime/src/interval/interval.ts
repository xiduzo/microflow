import { MIN_INTERVAL_IN_MS } from './interval.constants';
import { Code } from '../base';
import type { Data, Value } from './interval.types';
import { dataSchema } from './interval.types';

export class Interval extends Code<Value, Data> {
	private timeout: NodeJS.Timeout | null = null;

	constructor(data: Data) {
		super(dataSchema.parse(data), 0);

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
