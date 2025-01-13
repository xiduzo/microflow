import {
	Button,
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@microflow/ui';
import { PropsWithChildren, useState } from 'react';
import { MatrixDisplay } from './MatrixDisplay';

function newMatrix(options: { dimensions: [number, number]; shape?: string[]; fill?: string }) {
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
		<Dialog>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="max-w-screen-md">
				<DialogHeader>
					<DialogTitle>{!!props.onDelete ? 'Edit' : 'Add new'} shape</DialogTitle>
				</DialogHeader>
				<div className="p-4 overflow-x-scroll flex items-center justify-center">
					<MatrixDisplay
						dimensions={props.dimensions}
						shape={matrix}
						onCellClick={(row, column) => {
							setMatrix(prevMatrix => {
								const prev = prevMatrix[row].at(column);
								const newMatrix = Object.assign([], prevMatrix) as string[];
								const newValue = Number(prev) ? '0' : '1';
								const newRow = newMatrix[row].split('');
								newRow[column] = newValue;
								newMatrix[row] = newRow.join('');
								return newMatrix;
							});
						}}
					/>
				</div>
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
				<DialogFooter className="gap-2 sm:gap-0">
					{props.onDelete && (
						<DialogClose asChild>
							<Button onClick={props.onDelete} variant="destructive">
								Delete shape
							</Button>
						</DialogClose>
					)}
					<DialogClose asChild>
						<Button onClick={() => props.onSave(matrix)}>Save shape</Button>
					</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type Props = PropsWithChildren & {
	dimensions: [number, number];
	shape: string[];
	onSave: (shape: string[]) => void;
	onDelete?: () => void;
};

export type { Props as MatrixEditorProps };
