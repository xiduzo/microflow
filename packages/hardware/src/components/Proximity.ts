import JohnnyFive, { ProximityOption } from 'johnny-five';
import { Hardware, BaseComponentData } from './BaseComponent';

export type ProximityData = Omit<ProximityOption, 'board'>;
export type ProximityValueType = number;

export class Proximity extends Hardware<ProximityValueType, ProximityData, JohnnyFive.Proximity> {
	constructor(data: BaseComponentData & ProximityData) {
		super(data, 0);
	}

	protected createComponent(data: BaseComponentData & ProximityData) {
		this.component = new JohnnyFive.Proximity(data);

		this.component.on('data', data => {
			this.value = data.cm;
		});
		return this.component;
	}
}
