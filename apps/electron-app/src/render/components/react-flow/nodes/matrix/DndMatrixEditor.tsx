import {
	cva,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '@ui/index';
import { useDragAndDrop } from '../../../../providers/DragAndDropProvider';
import { MatrixDisplay } from './MatrixDisplay';
import { MatrixEditor, MatrixEditorProps } from './MatrixEditor';

export function DndMatrixEditor(props: Props) {
	const { dragging, setDragging, setHover } = useDragAndDrop();

	const rows = props.shape.length;
	const cols = props.shape[0].length;

	return (
		<MatrixEditor
			onSave={props.onSave}
			dimensions={[rows, cols]}
			onDelete={props.onDelete}
			shape={props.shape}
		>
			<div
				style={{ opacity: dragging === props.id ? 0.25 : 1 }}
				draggable
				onDragStart={setDragging(props.id)}
				onDragEnd={setDragging('')}
				onDragEnter={setHover(props.id)}
				onDragLeave={setHover('')}
				className={gridItem({
					cols: (12 / Math.round(32 / cols)) as keyof typeof gridItem,
				})}
			>
				<TooltipProvider>
					<Tooltip>
						<TooltipContent>Shape #{props.index}</TooltipContent>
						<TooltipTrigger className="w-full">
							<MatrixDisplay
								size="tiny"
								dimensions={[rows, cols]}
								shape={props.shape}
							/>
						</TooltipTrigger>
					</Tooltip>
				</TooltipProvider>
			</div>
		</MatrixEditor>
	);
}

type Props = MatrixEditorProps & {
	id: string;
	index: number;
};

const gridItem = cva('cursor-grab mx-1', {
	variants: {
		cols: {
			1: 'col-span-1',
			2: 'col-span-2',
			3: 'col-span-3',
			4: 'col-span-4',
			5: 'col-span-5',
			6: 'col-span-6',
			7: 'col-span-7',
			8: 'col-span-8',
			9: 'col-span-9',
			10: 'col-span-10',
			11: 'col-span-11',
			12: 'col-span-12',
		},
	},
});
