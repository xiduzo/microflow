import JohnnyFive, { ProximityOption } from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type ProximityData = Omit<ProximityOption, 'board'>;
export type ProximityValueType = number;

export class Proximity extends BaseComponent<
	ProximityValueType,
	ProximityData,
	JohnnyFive.Proximity
> {
	constructor(data: BaseComponentData & ProximityData) {
		super(data, 0);

		this.createComponent(data);
		this.on('new-data', data => this.createComponent(data as BaseComponentData & ProximityData));
	}

	private createComponent(data: BaseComponentData & ProximityData) {
		this.component = new JohnnyFive.Proximity(data);

		this.component.on('data', data => {
			this.value = data.cm;
		});
	}
}
