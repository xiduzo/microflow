import { Button, cva } from '@microflow/ui';
import { useState } from 'react';

function newMatrix(dimensions: [number, number], fill = 1): number[][] {
	return Array.from({ length: dimensions[0] }, () =>
		new Array(dimensions[0]).fill(fill),
	);
}
export function MatrixEditor(props: Props) {
	const [matrix, setMatrix] = useState<number[][]>(newMatrix(props.dimensions));

	return (
		<div className="space-y-4">
			<h1>Matrix Editor</h1>
			<section className="grid grid-cols-8 gap-2">
				{matrix.map((row, i) =>
					row.map((_cell, j) => (
						<div
							onChange={checked => {
								console.log(checked);
							}}
							onClick={() => {
								setMatrix(prevMatrix => {
									const prev = prevMatrix[i][j];
									const newMatrix = Object.assign([], prevMatrix);
									newMatrix[i][j] = prev ? 0 : 1;
									return newMatrix;
								});
							}}
							key={j}
							data-cell={`${i}-${j}`}
							className={cell({ active: Boolean(matrix[i][j]) })}
						/>
					)),
				)}
			</section>
			<section className="flex space-x-2">
				<Button
					className="grow"
					variant="outline"
					onClick={() => {
						setMatrix(newMatrix(props.dimensions));
					}}
				>
					Fill all
				</Button>
				<Button
					variant="outline"
					className="grow"
					onClick={() => {
						setMatrix(newMatrix(props.dimensions, 0));
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
};

const cell = cva(
	'place-self-center w-full h-11 ring-0 transition-all hover:ring-4 ring-blue-500 rounded-sm',
	{
		variants: {
			active: {
				true: 'bg-red-500',
				false: 'bg-muted scale-95',
			},
		},
	},
);
