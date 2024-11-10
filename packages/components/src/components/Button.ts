import JohnnyFive, { ButtonOption } from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type ButtonData = Omit<ButtonOption, 'board'>;
export type ButtonValueType = boolean | number;

type ButtonOptions = BaseComponentOptions & ButtonData;

export class Button extends BaseComponent<ButtonValueType> {
	private readonly component: JohnnyFive.Button;

	constructor(options: ButtonOptions) {
		super(options, false);

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
