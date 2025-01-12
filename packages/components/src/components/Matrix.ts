import JohnnyFive from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';
import { DEFAULT_MATRIX_START_SHAPE, type MatrixShape } from '../constants/Matrix';
import { transformValueToNumber } from '../utils/transformUnknownValues';

export type MatrixData = Omit<
	JohnnyFive.Led.MatrixOption & JohnnyFive.Led.MatrixIC2Option,
	'board' | 'devices'
> & {
	shapes: MatrixShape[];
	dims: string;
	devices: number;
};
export type MatrixValueType = MatrixShape;

export class Matrix extends BaseComponent<MatrixValueType> {
	private readonly component: JohnnyFive.Led.Matrix;

	constructor(private readonly data: BaseComponentData & MatrixData) {
		super(data, DEFAULT_MATRIX_START_SHAPE);

		this.component = new JohnnyFive.Led.Matrix(data);

		this.component.brightness(100);
		this.component.off();
	}

	show(index: unknown) {
		this.component.on();

		// Find the shape at the rounded index
		const shape = this.data.shapes.at(Math.round(transformValueToNumber(index) - 1));

		if (!shape) {
			return;
		}

		const columnWidth = this.getColumnWidth();
		const shapes = shape.reduce((acc, row) => {
			// Split each row into shapes of the column width
			const rowShapes = row.match(new RegExp(`.{1,${columnWidth}}`, 'g'));

			if (!rowShapes) return acc;

			// Push each shape into the correct index (device)
			rowShapes.forEach((shape, index) => {
				if (!acc[index]) {
					acc[index] = [];
				}
				acc[index].push(shape);
			});

			return acc;
		}, [] as MatrixShape[]);

		// Show each shape on the matrix for each device
		shapes.forEach((shape, index) => {
			this.component.draw(index, shape as any as number);
		});
		this.value = shape;
	}

	hide() {
		this.component.off();
		this.value = this.value.map(row => row.replace(/'1'/g, '0'));
	}

	private getColumnWidth() {
		return Number(this.data.dims.split('x').map(Number)[1]);
	}
}
