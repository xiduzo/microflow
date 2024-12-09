import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type AndValueType = boolean[];

export type AndData = {
	checks: number;
};

export type AndOptions = BaseComponentOptions & AndData;

export class And extends BaseComponent<AndValueType> {
	constructor(private readonly options: AndOptions) {
		super(options, Array.from({ length: options.checks }).fill(false).map(Boolean));
	}

	check(inputs: unknown[]) {
		this.value = inputs.map(input =>
			['1', 'true', 'on', 'yes'].includes(String(input).toLowerCase()),
		);

		const amountOfTrue = Object.values(this.value).filter(Boolean).length;
		this.eventEmitter.emit(
			amountOfTrue === this.options.checks ? 'true' : 'false',
			this.value,
			false,
		);
	}
}
