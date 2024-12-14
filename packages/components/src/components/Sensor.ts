import JohnnyFive, { SensorOption } from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type SensorData = Omit<SensorOption, 'board'>;
export type SensorValueType = number;

export class Sensor extends BaseComponent<SensorValueType> {
	private readonly component: JohnnyFive.Sensor;

	constructor(data: BaseComponentData & SensorData) {
		super(data, 0);
		this.component = new JohnnyFive.Sensor(data);

		this.component.on('change', () => {
			this.value = Number(this.component.raw);
		});
	}
}
