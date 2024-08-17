import { Led } from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type MatrixShape = string[];
export type MatrixData = Omit<
	Led.MatrixOption & Led.MatrixIC2Option,
	'board'
> & {
	shapes: MatrixShape[];
};
export type MatrixValueType = MatrixShape;

type MatrixOptions = BaseComponentOptions & MatrixData;

export class Matrix extends BaseComponent<MatrixValueType> {
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
