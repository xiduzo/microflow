import { BaseComponent, BaseComponentData } from './BaseComponent';

export type GateValueType = boolean;

type GateType = 'or' | 'and' | 'xor' | 'not' | 'nor' | 'nand' | 'xnor';

export type GateData = {
	gate: GateType;
	inputs: number;
};

export class Gate extends BaseComponent<GateValueType> {
	constructor(private readonly data: BaseComponentData & GateData) {
		super(data, false);
	}

	check(inputs: unknown[]) {
		const inputsAsBooleans = inputs.map(input =>
			['1', 'true', 'on', 'yes'].includes(String(input).toLowerCase()),
		);

		this.value = this.passesGate(inputsAsBooleans);

		this.eventEmitter.emit(this.value ? 'true' : 'false', this.value);
	}

	private passesGate(inputs: boolean[]) {
		const amountOfTrue = inputs.filter(Boolean).length;
		console.log(`Amount true: ${amountOfTrue}, inputs: ${this.data.inputs}`);
		switch (this.data.gate) {
			case 'not':
				return !(amountOfTrue === this.data.inputs);
			case 'and':
				return amountOfTrue === this.data.inputs;
			case 'nand':
				return amountOfTrue !== this.data.inputs;
			case 'or':
				return amountOfTrue > 0;
			case 'xor':
				return amountOfTrue === 1;
			case 'nor':
				return amountOfTrue === 0;
			case 'xnor':
				return amountOfTrue === 0 || amountOfTrue === this.data.inputs;
			default:
				return false;
		}
	}
}
