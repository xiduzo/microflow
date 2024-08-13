import JohnnyFive from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type ButtonOptions = BaseComponentOptions<number> & JohnnyFive.ButtonOption;

export class Button extends BaseComponent<number | boolean> {
	private readonly component: JohnnyFive.Button;
	constructor(private readonly options: ButtonOptions) {
		super(options);

		this.component = new JohnnyFive.Button(options);

		this.component.on('up', () => {
			this.value = false;
			this.eventEmitter.emit('inactive', this.value, false);
		});
		this.component.on('down', () => {
			this.value = true;
			this.eventEmitter.emit('active', this.value, false);
		});
		this.component.on('hold', () => {
			this.eventEmitter.emit('hold', this.value);
		});
	}
}
