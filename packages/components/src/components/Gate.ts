import { transformValueToBoolean } from '../utils/transformUnknownValues';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type GateValueType = boolean;

type GateType = 'or' | 'and' | 'xor' | 'not' | 'nor' | 'nand' | 'xnor';

export type GateData = {
	gate: GateType;
};

export class Gate extends BaseComponent<GateValueType> {
	constructor(private readonly data: BaseComponentData & GateData) {
		super(data, false);
	}

	check(inputs: unknown[]) {
		const inputsAsBooleans = inputs.map(transformValueToBoolean);

		this.value = this.passesGate(inputsAsBooleans);

		this.eventEmitter.emit(this.value ? 'true' : 'false', this.value);
	}

	private passesGate(inputs: boolean[]) {
		const amountOfTrue = inputs.filter(Boolean).length;
		switch (this.data.gate) {
			case 'not':
				return !amountOfTrue;
			case 'and':
				return amountOfTrue === 2;
			case 'nand':
				return amountOfTrue !== 2;
			case 'or':
				return amountOfTrue > 0;
			case 'xor':
				return amountOfTrue === 1;
			case 'nor':
				return amountOfTrue === 0;
			case 'xnor':
				return amountOfTrue !== 1;
			default:
				return false;
		}
	}
}
