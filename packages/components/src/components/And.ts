import { BaseComponent, BaseComponentData } from './BaseComponent';

export type AndValueType = boolean[];

export type AndData = {
	checks: number;
};

export class And extends BaseComponent<AndValueType> {
	constructor(private readonly data: BaseComponentData & AndData) {
		super(data, Array.from({ length: data.checks }).fill(false).map(Boolean));
	}

	check(inputs: unknown[]) {
		this.value = inputs.map(input =>
			['1', 'true', 'on', 'yes'].includes(String(input).toLowerCase()),
		);

		const amountOfTrue = Object.values(this.value).filter(Boolean).length;
		this.eventEmitter.emit(amountOfTrue === this.data.checks ? 'true' : 'false', this.value, false);
	}
}
