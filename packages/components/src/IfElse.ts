import EventEmitter from 'events';

export type IfElseOptions = {
	validator: 'boolean' | 'number' | 'text';
	subValidator?:
		| 'equal to'
		| 'greater than'
		| 'less than'
		| 'between'
		| 'outside'
		| 'is even'
		| 'is odd'
		| 'includes'
		| 'starts with'
		| 'ends with';
	validatorArgs: any[];
	id: string;
};

export class IfElse extends EventEmitter {
	#value = false;

	constructor(private readonly options: IfElseOptions) {
		super();

		this.on('change', this.#postMessage.bind(this, 'change'));
		this.on('true', this.#postMessage.bind(this, 'true'));
		this.on('false', this.#postMessage.bind(this, 'false'));
	}

	get value() {
		return this.#value;
	}

	set value(value) {
		this.#value = value;
		this.emit(value ? 'true' : 'false', value);
	}

	check(input: never) {
		const validator = this.#validator();
		this.value = validator(input);
	}

	#validator() {
		switch (this.options.validator) {
			case 'boolean':
				return (input: boolean | string) =>
					input === true ||
					['1', 'true', 'on', 'yes'].includes(String(input).toLowerCase());
			case 'number':
				const [num1, num2] = this.options.validatorArgs.map(Number);
				switch (this.options.subValidator) {
					case 'equal to':
						return (input: number) => input == num1;
					case 'greater than':
						return (input: number) => input > num1;
					case 'less than':
						return (input: number) => input < num1;
					case 'between':
						return (input: number) => input > num1 && input < num2;
					case 'outside':
						return (input: number) => input < num1 && input > num2;
					case 'is even':
						return (input: number) => Math.round(input) % 2 === 0;
					case 'is odd':
						return (input: number) => Math.round(input) % 2 !== 0;
					default:
						return () => false;
				}
			case 'text':
				const [expected] = this.options.validatorArgs.map(String);
				switch (this.options.subValidator) {
					case 'equal to':
						return (input: string) => input === expected;
					case 'includes':
						return (input: string) => input.includes(expected);
					case 'starts with':
						return (input: string) => input.startsWith(expected);
					case 'ends with':
						return (input: string) => input.endsWith(expected);
					default:
						return () => false;
				}
			default:
				return () => false;
		}
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
