import { Led } from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type MatrixOptions = BaseComponentOptions<any> &
	(Led.MatrixOption | Led.MatrixIC2Option) & {
		shapes: string[][];
	};

export class Matrix extends BaseComponent<string[]> {
	private readonly controller: Led.Matrix;
	constructor(private readonly options: MatrixOptions) {
		super(options);

		this.controller = new Led.Matrix(options);

		this.controller.brightness(100);
		this.controller.off();
	}

	show(index: number) {
		this.controller.on();

		const shape = this.options.shapes[index];

		if (!shape) {
			return;
		}

		this.controller.draw(0, shape as any as number);
		this.value = shape;
	}

	hide() {
		this.controller.off();
		this.value = this.value.map(row => row.replace(/'1'/g, '0'));
	}
}
