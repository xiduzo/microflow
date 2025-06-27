import JohnnyFive, { ButtonOption } from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type ButtonData = Omit<ButtonOption, 'board'>;
export type ButtonValueType = boolean | number;

export class Button extends BaseComponent<ButtonValueType> {
	private readonly component: JohnnyFive.Button;

	constructor(data: BaseComponentData & ButtonData) {
		super(data, false);

		this.component = new JohnnyFive.Button(data);

		this.component.on('up', () => {
			this.value = false;
			this.emit('inactive', this.value);
		});
		this.component.on('down', () => {
			this.value = true;
			this.emit('active', this.value);
		});
		this.component.on('hold', () => {
			this.emit('hold', this.value);
		});
	}
}
