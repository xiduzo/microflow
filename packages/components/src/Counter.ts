import EventEmitter from 'events';

export class Counter extends EventEmitter {
	#value = 0;

	constructor(private readonly options: Record<string, any>) {
		super();

		this.on('change', this.#postMessage.bind(this, 'change'));
	}

	set value(value: any) {
		this.#value = parseInt(value);
		this.emit('change', this.value);
	}

	get value() {
		return this.#value;
	}

	increment(amount = 1) {
		this.value += amount;
	}

	decrement(amount = 1) {
		this.value -= amount;
	}

	reset() {
		this.value = 0;
	}

	set(value: any) {
		this.value = value;
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
