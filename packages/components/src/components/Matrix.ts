import JohnnyFive, { Led } from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';
import { DEFAULT_MATRIX_START_SHAPE, type MatrixShape } from '../constants/Matrix';

export type MatrixData = Omit<Led.MatrixOption & Led.MatrixIC2Option, 'board'> & {
	shapes: MatrixShape[];
};
export type MatrixValueType = MatrixShape;

export class Matrix extends BaseComponent<MatrixValueType> {
	private readonly component: JohnnyFive.Led.Matrix;

	constructor(private readonly data: BaseComponentData & MatrixData) {
		super(data, DEFAULT_MATRIX_START_SHAPE);

		this.component = new Led.Matrix(data);

		this.component.brightness(100);
		this.component.off();
	}

	show(index: number) {
		this.component.on();

		const shape = this.data.shapes[index];

		if (!shape) {
			return;
		}

		this.component.draw(0, shape as any as number);
		this.value = shape;
	}

	hide() {
		this.component.off();
		this.value = this.value.map(row => row.replace(/'1'/g, '0'));
	}
}
