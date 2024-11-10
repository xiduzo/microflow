import { type MatrixData, type MatrixValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from '../Node';
import { MatrixDisplay } from './MatrixDisplay';
import { useNodeValue } from '../../../../stores/node-data';
import { useBoard } from '../../../../providers/BoardProvider';
import { MODES } from '../../../../../common/types';
import { mapPinToPaneOption } from '../../../../../utils/pin';
import { DEFAULT_MATRIX_SHAPE, DEFAULT_MATRIX_START_SHAPE } from '@microflow/components/contants';
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	ScrollArea,
} from '@ui/index';
import { uuid } from '../../../../../utils/uuid';
import { DragAndDropProvider } from '../../../../providers/DragAndDropProvider';
import { DndMatrixEditor } from './DndMatrixEditor';
import { MatrixEditor } from './MatrixEditor';
import { usePins } from '../../../../stores/board';

export function Matrix(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle
				type="target"
				position={Position.Left}
				id="show"
				hint="shows the shape #"
				offset={-0.5}
			/>
			<Handle type="target" position={Position.Left} id="hide" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id } = useNode();
	const value = useNodeValue<MatrixValueType>(id, DEFAULT_MATRIX_START_SHAPE);

	return <MatrixDisplay className="m-4" size="small" dimensions={[8, 8]} shape={value} />;
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<MatrixData>();
	const pins = usePins();
	const [editorOpened, setEditorOpened] = useState(false);

	const [shapes, setShapes] = useState(
		settings.shapes.map(shape => ({
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
		settings.shapes = shapes.map(({ shape }) => shape);
	}, [shapes, settings.shapes]);

	useEffect(() => {
		if (!pane) return;

		pane
			.addBlade({
				view: 'list',
				disabled: !pins.length,
				label: 'data (DIN)',
				index: 0,
				value: settings.pins.data,
				options: pins
					.filter(
						pin =>
							pin.supportedModes.includes(MODES.INPUT) &&
							!pin.supportedModes.includes(MODES.ANALOG),
					)
					.map(mapPinToPaneOption),
			})
			// @ts-ignore-next-line
			.on('change', (event: TpChangeEvent) => {
				settings.pins.data = event.value;
			});

		pane
			.addBlade({
				view: 'list',
				disabled: !pins.length,
				label: 'clock (CLK)',
				index: 1,
				value: settings.pins.clock,
				options: pins
					.filter(
						pin =>
							pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.PWM),
					)
					.map(mapPinToPaneOption),
			})
			// @ts-ignore-next-line
			.on('change', (event: TpChangeEvent) => {
				settings.pins.clock = event.value;
			});

		pane
			.addBlade({
				view: 'list',
				disabled: !pins.length,
				label: 'chip select (CS)',
				index: 2,
				value: settings.pins.cs,
				options: pins
					.filter(
						pin =>
							pin.supportedModes.includes(MODES.INPUT) &&
							!pin.supportedModes.includes(MODES.ANALOG),
					)
					.map(mapPinToPaneOption),
			})
			// @ts-ignore-next-line
			.on('change', (event: TpChangeEvent) => {
				settings.pins.cs = event.value;
			});

		pane
			.addButton({
				label: 'shapes',
				title: 'edit shapes',
				index: 3,
			})
			.on('click', () => {
				setEditorOpened(true);
			});
	}, [pane, settings, pins]);

	if (!editorOpened) return null;

	return (
		<Dialog defaultOpen onOpenChange={setEditorOpened}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Shapes</DialogTitle>
					<DialogDescription>Define the shapes for the matrix</DialogDescription>
				</DialogHeader>
				<ScrollArea className="h-60 p-2 border">
					<section className="grid grid-cols-12 gap-2">
						<DragAndDropProvider swap={swapShapes}>
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
										}}
										dimensions={settings.dims}
										onDelete={() => {
											const nextShapes = [...shapes];
											nextShapes.splice(index, 1);
											setShapes(nextShapes);
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
						setShapes([...shapes, { id: uuid(), shape: newShape }]);
					}}
					dimensions={settings.dims}
					shape={DEFAULT_MATRIX_SHAPE}
				>
					<Button variant="outline">Add new shape</Button>
				</MatrixEditor>
			</DialogContent>
		</Dialog>
	);
}

type Props = BaseNode<MatrixData, MatrixValueType>;
export const DEFAULT_MATRIX_DATA: Props['data'] = {
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
