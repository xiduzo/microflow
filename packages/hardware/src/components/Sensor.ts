import JohnnyFive, { SensorOption } from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type SensorData = Omit<SensorOption, 'board'>;
export type SensorValueType = number;

export class Sensor extends BaseComponent<SensorValueType, SensorData, JohnnyFive.Sensor> {
	constructor(data: BaseComponentData & SensorData) {
		super(data, 0);
		this.createComponent(data);
		this.on('new-data', data => this.createComponent(data as BaseComponentData & SensorData));
	}

	private createComponent(data: BaseComponentData & SensorData) {
		this.component = new JohnnyFive.Sensor(data);
		this.value = Number(this.component.raw);

		this.component.on('change', () => {
			this.value = Number(this.component?.raw ?? 0);
		});
	}
}
