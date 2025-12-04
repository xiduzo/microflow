import JohnnyFive from 'johnny-five';
import { Hardware } from '../base';
import { DEFAULT_MATRIX_START_SHAPE, type MatrixShape } from './matrix.constants';
import { transformValueToNumber } from '../_utils/transformUnknownValues';
import type { Data, Value } from './matrix.types';
import { dataSchema } from './matrix.types';

export class Matrix extends Hardware<Value, Data, JohnnyFive.Led.Matrix> {
	constructor(data: Data) {
		super(dataSchema.parse(data), DEFAULT_MATRIX_START_SHAPE);
	}

	show(index: unknown) {
		this.component?.on();

		// Find the shape at the rounded index
		const shape = this.data.shapes.at(Math.round(transformValueToNumber(index) - 1));

		if (!shape) return;

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
			this.component?.draw(index, shape as any as number);
		});
		this.value = shape;
	}

	hide() {
		this.component?.off();
		this.value = this.value.map(row => row.replace(/'1'/g, '0'));
	}

	private getColumnWidth() {
		return Number(this.data.dims.split('x').map(Number)[1]);
	}

	protected createComponent(data: Data) {
		this.component = new JohnnyFive.Led.Matrix(data);

		this.component.brightness(100);
		this.component.off();
		return this.component;
	}
}
