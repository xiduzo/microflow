import Logger from 'electron-log/node';
import { Led } from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type MatrixOptions = BaseComponentOptions<any> &
	(Led.MatrixOption | Led.MatrixIC2Option);

export class Matrix extends BaseComponent<any> {
	private readonly controller: Led.Matrix;
	constructor(private readonly options: MatrixOptions) {
		super(options);

		this.controller = new Led.Matrix(options);
		Logger.debug('Matrix created', options);

		this.controller.brightness(100);
		this.controller.off();
	}

	draw() {}
}
