import type { MatrixData, MatrixShape, MatrixValueType } from '@microflow/components';
import { Button, Label, ScrollArea } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useState } from 'react';
import { MODES } from '../../../../../common/types';
import { uuid } from '../../../../../utils/uuid';
import { useBoard } from '../../../../providers/BoardProvider';
import { DragAndDropProvider } from '../../../../providers/DragAndDropProvider';
import { PinSelect } from '../../../PinSelect';
import { Handle } from '../Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
	useNodeSettings,
} from '../Node';
import { DndMatrixEditor } from './DndMatrixEditor';
import { MatrixDisplay } from './MatrixDisplay';
import { MatrixEditor } from './MatrixEditor';

export function Matrix(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue>
					<MatrixDisplay size="small" dimensions={[8, 8]} shape={props.data.value} />
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<MatrixSettings />
			</NodeSettings>
			<Handle
				type="target"
				position={Position.Left}
				id="show"
				hint="shows the shape #"
				offset={-0.5}
			/>
			<Handle type="target" position={Position.Left} id="hide" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" offset={-1} />
		</NodeContainer>
	);
}

function MatrixSettings() {
	const { settings, setSettings } = useNodeSettings<MatrixData>();
	const { pins } = useBoard();

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

	return (
		<>
			<section className="flex space-x-2">
				<div className="flex-grow">
					<Label className="pb-2">Data</Label>
					<PinSelect
						value={settings.pins.data}
						onValueChange={data => setSettings({ pins: { ...settings.pins, data } })}
						filter={pin =>
							pin.supportedModes.includes(MODES.INPUT) && !pin.supportedModes.includes(MODES.ANALOG)
						}
					/>
				</div>
				<div className="flex-grow">
					<Label>Clock</Label>
					<PinSelect
						value={settings.pins.clock}
						onValueChange={clock => setSettings({ pins: { ...settings.pins, clock } })}
						filter={pin =>
							pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.PWM)
						}
					/>
				</div>
				<div className="flex-grow">
					<Label>CS</Label>
					<PinSelect
						value={settings.pins.cs}
						onValueChange={cs => setSettings({ pins: { ...settings.pins, cs } })}
						filter={pin =>
							pin.supportedModes.includes(MODES.INPUT) && !pin.supportedModes.includes(MODES.ANALOG)
						}
					/>
				</div>
			</section>
			<ScrollArea className="h-60 p-2 border">
				<section className="grid grid-cols-12 gap-2">
					<DragAndDropProvider
						swap={swapShapes}
						onDragDone={() => setSettings({ shapes: shapes.map(({ shape }) => shape) })}
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
										setSettings({
											shapes: nextShapes.map(({ shape }) => shape),
										});
									}}
									dimensions={settings.dims}
									onDelete={() => {
										const nextShapes = [...shapes];
										nextShapes.splice(index, 1);
										setShapes(nextShapes);
										setSettings({
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
					setSettings({ shapes: [...settings.shapes, newShape] });
				}}
				dimensions={settings.dims}
				shape={DEFAULT_MATRIX_SHAPE}
			>
				<Button variant="outline">Add new shape</Button>
			</MatrixEditor>
		</>
	);
}

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

type Props = BaseNode<MatrixData, MatrixValueType>;
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
