import { transformValueToBoolean } from '../utils/transformUnknownValues';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type GateValueType = boolean;

type GateType = 'or' | 'and' | 'xor' | 'not' | 'nor' | 'nand' | 'xnor';

export type GateData = {
	gate: GateType;
};

export class Gate extends BaseComponent<GateValueType, GateData> {
	constructor(data: BaseComponentData & GateData) {
		super(data, false);
	}

	check(inputs: unknown[]) {
		const inputsAsBooleans = inputs.map(transformValueToBoolean);

		this.value = this.passesGate(inputsAsBooleans);

		this.emit(this.value ? 'true' : 'false', this.value);
	}

	private passesGate(inputs: boolean[]) {
		const amountOfTrue = inputs.filter(Boolean).length;
		switch (this.data.gate) {
			case 'not':
				if (amountOfTrue === inputs.length) return false;
				return true;
			case 'and':
				return amountOfTrue === inputs.length;
			case 'nand':
				return amountOfTrue !== inputs.length;
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
