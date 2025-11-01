import JohnnyFive, { ProximityOption } from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type ProximityData = Omit<ProximityOption, 'board'>;
export type ProximityValueType = number;

export class Proximity extends BaseComponent<ProximityValueType, ProximityData> {
	private readonly component: JohnnyFive.Proximity;

	constructor(data: BaseComponentData & ProximityData) {
		super(data, 0);

		this.component = new JohnnyFive.Proximity(data);

		this.component.on('data', data => {
			this.value = data.cm;
		});
	}
}
