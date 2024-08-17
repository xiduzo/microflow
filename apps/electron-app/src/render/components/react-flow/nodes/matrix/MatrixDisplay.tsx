import { cva, VariantProps } from '@microflow/ui';
import { MatrixEditorProps } from './MatrixEditor';

export function MatrixDisplay(props: Props) {
	const [rows, columns] = props.dimensions;
	return (
		<section
			className={matrix({
				size: props.size ?? (columns > 16 ? 'medium' : 'large'),
			})}
			style={{
				gridTemplateRows: `repeat(${rows}, 1fr)`,
				gridTemplateColumns: `repeat(${columns}, 1fr)`,
			}}
		>
			{Array.from({ length: rows }).map((_row, row) =>
				Array.from({ length: columns }).map((_column, column) => (
					<div
						onClick={() => props.onCellClick?.(row, column)}
						key={column}
						data-cell={`${row}-${column}`}
						className={cell({
							size: props.size ?? (columns > 16 ? 'medium' : 'large'),
							active: Boolean(Number(props.shape[row]?.[column] ?? '0')),
							editable: !!props.onCellClick,
						})}
					/>
				)),
			)}
		</section>
	);
}

const matrix = cva('w-full grid', {
	variants: {
		size: {
			tiny: 'gap-0.5',
			small: 'gap-0.5',
			medium: 'gap-1',
			large: 'gap-2',
		},
	},
	defaultVariants: {
		size: 'large',
	},
});

const cell = cva('place-self-center w-full ring-0 transition-all', {
	variants: {
		editable: {
			true: 'hover:ring-4 cursor-pointer ring-blue-500',
			false: '',
		},
		active: {
			true: 'bg-red-500',
			false: 'bg-muted-foreground/10',
		},
		size: {
			tiny: 'h-2 rounded-[2px]',
			small: 'h-4 rounded',
			medium: 'h-8 rounded-sm',
			large: 'h-12 rounded-sm',
		},
	},
	defaultVariants: {
		active: false,
		size: 'large',
	},
});

type Props = Omit<MatrixEditorProps, 'onSave'> & {
	onCellClick?: (row: number, column: number) => void;
	cellClassName?: string;
} & Pick<VariantProps<typeof cell>, 'size'>;
