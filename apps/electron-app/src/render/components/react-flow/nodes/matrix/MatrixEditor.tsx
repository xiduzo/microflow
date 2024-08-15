import { Button } from '@microflow/ui';
import { useState } from 'react';
import { MatrixDisplay } from './MatrixDisplay';

function newMatrix(options: {
	dimensions: [number, number];
	shape?: string[];
	fill?: string;
}) {
	const [rows, columns] = options.dimensions;

	const matrix = Array.from({ length: rows }, () =>
		new Array(columns).fill(options.fill ?? '0').join(''),
	);

	options.shape?.forEach((row, rowIndex) => {
		const newRow = matrix[rowIndex].split('');
		row.split('').forEach((cell, columnIndex) => {
			newRow[columnIndex] = cell;
		});
		matrix[rowIndex] = newRow.join('');
	});

	return matrix;
}

export function MatrixEditor(props: Props) {
	const [matrix, setMatrix] = useState<string[]>(
		newMatrix({
			dimensions: props.dimensions,
			shape: props.shape,
		}),
	);

	return (
		<div className="space-y-4">
			<MatrixDisplay
				dimensions={props.dimensions}
				shape={matrix}
				onCellClick={(row, column) => {
					setMatrix(prevMatrix => {
						const prev = prevMatrix[row].at(column);
						const newMatrix = Object.assign([], prevMatrix);
						const newValue = Number(prev) ? '0' : '1';
						const newRow = newMatrix[row].split('');
						newRow[column] = newValue;
						newMatrix[row] = newRow.join('');
						return newMatrix;
					});
				}}
			/>
			<section className="flex space-x-2">
				<Button
					className="grow"
					variant="outline"
					onClick={() => {
						setMatrix(
							newMatrix({
								dimensions: props.dimensions,
								fill: '1',
							}),
						);
					}}
				>
					Fill all
				</Button>
				<Button
					variant="outline"
					className="grow"
					onClick={() => {
						setMatrix(
							newMatrix({
								dimensions: props.dimensions,
								fill: '0',
							}),
						);
					}}
				>
					Clear all
				</Button>
			</section>
		</div>
	);
}

type Props = {
	dimensions: [number, number];
	shape: string[];
};

export type { Props as MatrixEditorProps };
