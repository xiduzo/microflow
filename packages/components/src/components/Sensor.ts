import JohnnyFive from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type SensorOptions = BaseComponentOptions<number> & JohnnyFive.SensorOption;

export class Sensor extends BaseComponent<number> {
	private readonly component: JohnnyFive.Sensor;

	constructor(private readonly options: SensorOptions) {
		super(options);
		this.component = new JohnnyFive.Sensor(options);

		this.component.on('change', () => {
			this.value = this.component.raw;
		});
	}
}
