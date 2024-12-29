import { type MatrixData, type MatrixValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from '../Node';
import { MatrixDisplay } from './MatrixDisplay';
import { useNodeValue } from '../../../../stores/node-data';
import { MODES } from '../../../../../common/types';
import { mapPinToPaneOption } from '../../../../../utils/pin';
import {
	DEFAULT_MATRIX_SHAPE,
	DEFAULT_MATRIX_START_SHAPE,
	MatrixShape,
} from '@microflow/components/contants';
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	ListBladeApi,
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
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<MatrixValueType>(DEFAULT_MATRIX_START_SHAPE);

	return <MatrixDisplay className="m-4" size="small" dimensions={[8, 8]} shape={value} />;
}

function Settings() {
	const data = useNodeData<MatrixData>();
	const { pane, settings, saveSettings } = useNodeSettings<MatrixData>();
	const pins = usePins();
	const [editorOpened, setEditorOpened] = useState(false);

	const [shapes, setShapes] = useState(
		(settings.shapes ?? data.shapes ?? [DEFAULT_MATRIX_SHAPE]).map(shape => ({
			id: uuid(),
			shape,
		})),
	);

	function updateShapes(newShapes: { id: string; shape: MatrixShape }[]) {
		setShapes(newShapes);
		settings.shapes = newShapes.map(({ shape }) => shape);
		saveSettings();
	}

	function swapShapes(id: string, hoveredId: string) {
		const nextShapes = [...shapes];
		const leftIndex = shapes.findIndex(shape => shape.id === id);
		const rightIndex = shapes.findIndex(shape => shape.id === hoveredId);

		nextShapes[leftIndex] = shapes[rightIndex];
		nextShapes[rightIndex] = shapes[leftIndex];
		updateShapes(nextShapes);
	}

	useEffect(() => {
		settings.shapes = shapes.map(({ shape }) => shape);
	}, [shapes, settings.shapes]);

	useEffect(() => {
		if (!pane) return;

		const dataPinBlade = pane.addBlade({
			view: 'list',
			disabled: !pins.length,
			label: 'data (DIN)',
			index: 0,
			value: settings.pins.data,
			options: pins
				.filter(
					pin =>
						pin.supportedModes.includes(MODES.INPUT) && !pin.supportedModes.includes(MODES.ANALOG),
				)
				.map(mapPinToPaneOption),
		});

		(dataPinBlade as ListBladeApi<number | string>).on('change', event => {
			settings.pins.data = event.value;
		});

		const clockPinBlade = pane.addBlade({
			view: 'list',
			disabled: !pins.length,
			label: 'clock (CLK)',
			index: 1,
			value: settings.pins.clock,
			options: pins
				.filter(
					pin => pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.PWM),
				)
				.map(mapPinToPaneOption),
		});

		(clockPinBlade as ListBladeApi<number | string>).on('change', event => {
			settings.pins.clock = event.value;
		});

		const chipSeletPinBlade = pane.addBlade({
			view: 'list',
			disabled: !pins.length,
			label: 'chip select (CS)',
			index: 2,
			value: settings.pins.cs,
			options: pins
				.filter(
					pin =>
						pin.supportedModes.includes(MODES.INPUT) && !pin.supportedModes.includes(MODES.ANALOG),
				)
				.map(mapPinToPaneOption),
		});

		(chipSeletPinBlade as ListBladeApi<number | string>).on('change', event => {
			settings.pins.cs = event.value;
		});

		const shapesButton = pane
			.addButton({
				label: 'shapes',
				title: 'edit shapes',
				index: 3,
			})
			.on('click', () => {
				setEditorOpened(true);
			});

		return () => {
			[dataPinBlade, clockPinBlade, chipSeletPinBlade, shapesButton].forEach(disposable => {
				disposable.dispose();
			});
		};
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
											updateShapes(nextShapes);
										}}
										dimensions={settings.dims}
										onDelete={() => {
											const nextShapes = [...shapes];
											nextShapes.splice(index, 1);
											updateShapes(nextShapes);
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
						updateShapes([...shapes, { id: uuid(), shape: newShape }]);
					}}
					dimensions={settings.dims}
					shape={[]}
				>
					<Button variant="outline">Add new shape</Button>
				</MatrixEditor>
			</DialogContent>
		</Dialog>
	);
}

type Props = BaseNode<MatrixData>;
Matrix.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['output', 'analog'],
		label: 'LED Matrix',
		pins: {
			data: 2,
			clock: 3,
			cs: 4,
		},
		controller: undefined as unknown as string,
		dims: [8, 8], // [rows, columns]
		shapes: [DEFAULT_MATRIX_SHAPE],
	} satisfies Props['data'],
};
