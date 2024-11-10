import JohnnyFive, { SensorOption } from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type SensorData = Omit<SensorOption, 'board'>;
export type SensorValueType = number;

type SensorOptions = BaseComponentOptions & SensorData;

export class Sensor extends BaseComponent<SensorValueType> {
	private readonly component: JohnnyFive.Sensor;

	constructor(options: SensorOptions) {
		super(options, 0);
		this.component = new JohnnyFive.Sensor(options);

		this.component.on('change', () => {
			this.value = Number(this.component.raw);
		});
	}
}
