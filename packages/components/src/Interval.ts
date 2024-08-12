import EventEmitter from 'events';

type IntervalOptions = {
	interval: number;
	id: string;
};

export class Interval extends EventEmitter {
	#minIntervalInMs = 500;
	#value = 0;

	constructor(private readonly options: IntervalOptions) {
		super();

		this.on('change', this.#postMessage.bind(this, 'change'));

		setInterval(() => {
			this.value = performance.now();
		}, this.#interval(options.interval));
	}

	set value(value) {
		this.#value = value;
		this.emit('change', value);
	}

	get value() {
		return this.#value;
	}

	#interval(interval: number) {
		const parsed = parseInt(String(interval));
		const isNumber = !isNaN(parsed);

		if (!isNumber) {
			return this.#minIntervalInMs;
		}

		return Math.max(this.#minIntervalInMs, parsed);
	}

	#postMessage(action: string) {
		if (action !== 'change') {
			this.emit('change', this.value);
		}

		(process as any).parentPort.postMessage({
			nodeId: this.options.id,
			action,
			value: this.value,
		});
	}
}
