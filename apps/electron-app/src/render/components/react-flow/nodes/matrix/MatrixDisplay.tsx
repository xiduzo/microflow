import { cva } from '@microflow/ui';
import { MatrixEditorProps } from './MatrixEditor';

export function MatrixDisplay(props: Props) {
	const [rows, columns] = props.dimensions;

	return (
		<section
			className={matrix({ className: props.className })}
			style={{
				gridTemplateRows: `repeat(${rows}, 20px)`,
				gridTemplateColumns: `repeat(${columns}, 20px)`,
			}}
		>
			{Array.from({ length: rows }).map((_row, row) =>
				Array.from({ length: columns }).map((_column, column) => (
					<div
						onClick={() => props.onCellClick?.(row, column)}
						key={column}
						data-cell={`${row}-${column}`}
						className={cell({
							active: Boolean(Number(props.shape[row]?.[column] ?? '0')),
							editable: !!props.onCellClick,
						})}
					/>
				)),
			)}
		</section>
	);
}

const matrix = cva('grid gap-0.5', {
	variants: {
		size: {
			small: 'grid-cols-4',
			medium: 'grid-cols-8',
			large: 'grid-cols-12',
		},
	},
});

const cell = cva('place-self-center rounded-full ring-0 transition-all h-full w-full', {
	variants: {
		editable: {
			true: 'hover:ring-4 cursor-pointer ring-blue-500',
			false: '',
		},
		active: {
			true: 'bg-red-500',
			false: 'bg-muted-foreground/10',
		},
	},
	defaultVariants: {
		active: false,
	},
});

type Props = Omit<MatrixEditorProps, 'onSave'> & {
	onCellClick?: (row: number, column: number) => void;
	cellClassName?: string;
	className?: string;
};
