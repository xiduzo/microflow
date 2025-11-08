import JohnnyFive, { SensorOption } from 'johnny-five';
import { Hardware, BaseComponentData } from './BaseComponent';

export type SensorData = Omit<SensorOption, 'board'>;
export type SensorValueType = number;

export class Sensor extends Hardware<SensorValueType, SensorData, JohnnyFive.Sensor> {
	constructor(data: BaseComponentData & SensorData) {
		super(data, 0);
	}

	protected createComponent(data: BaseComponentData & SensorData) {
		this.component = new JohnnyFive.Sensor(data);
		this.component.on('change', () => {
			this.value = Number(this.component.raw);
		});
		return this.component;
	}
}
