import { Button, cva, ScrollArea } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { Led } from 'johnny-five';
import { useEffect, useState } from 'react';
import { uuid } from '../../../../../utils/uuid';
import { useUpdateNodeData } from '../../../../hooks/nodeUpdater';
import { DragAndDropProvider } from '../../../../providers/DragAndDropProvider';
import { Handle } from '../Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
} from '../Node';
import { DndMatrixEditor } from './DndMatrixEditor';
import { MatrixDisplay } from './MatrixDisplay';
import { MatrixEditor } from './MatrixEditor';

export function Matrix(props: Props) {
	const { updateNodeData } = useUpdateNodeData<MatrixData>(props.id);
	const [shapes, setShapes] = useState(
		props.data.shapes.map(shape => ({
			id: uuid(),
			shape,
		})),
	);

	function swapShapes(id: string, hoveredId: string) {
		const nextShapes = [...shapes];
		const leftIndex = shapes.findIndex(shape => shape.id === id);
		const rightIndex = shapes.findIndex(shape => shape.id === hoveredId);

		nextShapes[leftIndex] = shapes[rightIndex];
		nextShapes[rightIndex] = shapes[leftIndex];
		setShapes(nextShapes);
	}

	useEffect(() => {
		setShapes(
			props.data.shapes.map(shape => ({
				id: uuid(),
				shape,
			})),
		);
	}, [props.data.shapes.length]);

	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue>
					<MatrixDisplay
						size="small"
						dimensions={[8, 8]}
						shape={props.data.value}
					/>
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<ScrollArea className="h-96 p-4 border">
					<section className="grid grid-cols-12 gap-2">
						<DragAndDropProvider
							swap={swapShapes}
							onDragDone={() =>
								updateNodeData({ shapes: shapes.map(({ shape }) => shape) })
							}
						>
							{shapes.map(({ id, shape }, index) => {
								return (
									<DndMatrixEditor
										key={id}
										index={index}
										id={id}
										onSave={newShape => {
											const nextShapes = [...shapes];
											nextShapes[index] = {
												...nextShapes[index],
												shape: newShape,
											};
											setShapes(nextShapes);
											updateNodeData({
												shapes: nextShapes.map(({ shape }) => shape),
											});
										}}
										dimensions={props.data.dims}
										onDelete={() => {
											const nextShapes = [...shapes];
											nextShapes.splice(index, 1);
											setShapes(nextShapes);
											updateNodeData({
												shapes: nextShapes.map(({ shape }) => shape),
											});
										}}
										shape={shape}
									/>
								);
							})}
						</DragAndDropProvider>
					</section>
				</ScrollArea>
				<MatrixEditor
					key={shapes.length}
					onSave={newShape => {
						console.log('newShape', newShape);
						updateNodeData({ shapes: [...props.data.shapes, newShape] });
					}}
					dimensions={props.data.dims}
					shape={DEFAULT_MATRIX_SHAPE}
				>
					<Button variant="outline">Add new shape</Button>
				</MatrixEditor>
			</NodeSettings>
			<Handle
				type="target"
				position={Position.Left}
				id="show"
				hint="shows the shape #"
				offset={-0.5}
			/>
			<Handle type="target" position={Position.Left} id="hide" offset={0.5} />
			<Handle
				type="source"
				position={Position.Bottom}
				id="change"
				offset={-1}
			/>
		</NodeContainer>
	);
}

export type MatrixShape = string[];
export type MatrixData = Omit<
	Led.MatrixOption & Led.MatrixIC2Option,
	'board'
> & {
	shapes: MatrixShape[];
};

type Props = BaseNode<MatrixData, MatrixShape>;
export const DEFAULT_MATRIX_SHAPE: MatrixShape = [
	'01100110',
	'10011001',
	'10000001',
	'10000001',
	'01000010',
	'00100100',
	'00011000',
	'00000000',
];

export const DEFAULT_MATRIX_START_SHAPE: MatrixShape = [
	'00000000',
	'00000000',
	'00000000',
	'00000000',
	'00000000',
	'00000000',
	'00000000',
	'00000000',
];

export const DEFAULT_MATRIX_DATA: Props['data'] = {
	value: DEFAULT_MATRIX_START_SHAPE,
	label: 'LED Matrix',
	pins: {
		data: 2,
		clock: 3,
		cs: 4,
	},
	controller: undefined,
	dims: [8, 8], // [rows, columns]
	shapes: [DEFAULT_MATRIX_SHAPE],
};

const gridItem = cva(
	'cursor-pointer transition-all hover:ring-blue-500 hover:ring-4 m-1',
	{
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
	},
);
