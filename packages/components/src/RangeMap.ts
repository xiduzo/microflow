import EventEmitter from 'events';

type RangeMapOptions = {
	from: [number, number];
	to: [number, number];
	id: string;
};

export class RangeMap extends EventEmitter {
	#value = [0, 0];

	constructor(private readonly options: RangeMapOptions) {
		super();

		this.on('to', this.#postMessage.bind(this, 'to'));
		this.on('change', this.#postMessage.bind(this, 'change'));
	}

	get value() {
		return this.#value;
	}

	set value(value) {
		const previousValue = this.#value;

		this.#value = value;
		this.#postMessage('change');

		if (previousValue[1] !== value[1]) {
			this.emit('to', value[1]);
		}
	}

	from(input: boolean | string | number) {
		if (typeof input === 'boolean') {
			input = input ? 1 : 0;
		}

		if (typeof input === 'string') {
			input = parseFloat(input);
		}

		const inMin = this.options.from[0] ?? 0;
		const inMax = this.options.from[1] ?? 1023;
		const outMin = this.options.to[0] ?? 0;
		const outMax = this.options.to[1] ?? 1023;

		const output =
			((input - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
		const distance = outMax - outMin;
		const normalizedOutput = parseFloat(String(output)).toFixed(
			distance <= 10 ? 1 : 0,
		);
		this.value = [input, Number(normalizedOutput)];
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
