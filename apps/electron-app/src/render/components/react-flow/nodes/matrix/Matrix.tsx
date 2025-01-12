import { type MatrixData, type MatrixValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
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
	Carousel,
	CarouselContent,
	CarouselItem,
	CarouselNext,
	CarouselPrevious,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	ListBladeApi,
} from '@ui/index';
import { uuid } from '../../../../../utils/uuid';
import { MatrixEditor } from './MatrixEditor';
import { usePins } from '../../../../stores/board';

export function Matrix(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="show" hint="shows shape #" offset={-0.5} />
			<Handle type="target" position={Position.Left} id="hide" offset={0.5} />
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function getShape(dimensions: string, devices: number): [number, number] {
	switch (dimensions) {
		case '8x8':
			return [8, 8 * devices];
		case '16x8':
			return [16, 8 * devices];
		case '8x16':
			return [8, 16 * devices];
		default:
			return [8, 8];
	}
}

function Value() {
	const data = useNodeData<MatrixData>();
	const value = useNodeValue<MatrixValueType>(DEFAULT_MATRIX_START_SHAPE);

	return (
		<section className="flex items-center justify-center m-4">
			<MatrixDisplay dimensions={getShape(data.dims, data.devices)} shape={value} />
		</section>
	);
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

		const dimensionsBinding = pane.addBinding(settings, 'dims', {
			view: 'list',
			label: 'dimensions',
			index: 4,
			value: settings.dims,
			options: [
				{ text: '8x8', value: '8x8' },
				{ text: '16x8', value: '16x8' },
				{ text: '8x16', value: '8x16' },
			],
		});

		const devicesBinding = pane.addBinding(settings, 'devices', {
			index: 5,
			min: 1,
			max: 8,
			step: 1,
		});

		return () => {
			dataPinBlade.dispose();
			clockPinBlade.dispose();
			chipSeletPinBlade.dispose();
			shapesButton.dispose();
			dimensionsBinding.dispose();
			devicesBinding.dispose();
		};
	}, [pane, settings, pins]);

	const dimensions = useMemo(() => {
		return getShape(settings.dims, settings.devices);
	}, [settings.dims, settings.devices]);

	if (!editorOpened) return null;

	return (
		<Dialog defaultOpen onOpenChange={setEditorOpened}>
			<DialogContent className="max-w-screen-md">
				<DialogHeader>
					<DialogTitle>Shapes ({shapes.length})</DialogTitle>
					<DialogDescription>
						When showing a shape the input handle will round to the closest shape number
					</DialogDescription>
				</DialogHeader>
				<section className="flex items-center justify-center">
					<Carousel className="w-full max-w-xl">
						<CarouselContent>
							{shapes.map(({ id, shape }, index) => {
								return (
									<CarouselItem key={id}>
										<MatrixEditor
											dimensions={dimensions}
											onSave={newShape => {
												const nextShapes = [...shapes];
												nextShapes[index] = {
													...nextShapes[index],
													shape: newShape,
												};
												updateShapes(nextShapes);
											}}
											onDelete={() => {
												const nextShapes = [...shapes];
												nextShapes.splice(index, 1);
												updateShapes(nextShapes);
											}}
											shape={shape}
										>
											<section className="flex-col flex items-center justify-center">
												<section className="max-w-xl overflow-x-scroll py-8">
													<MatrixDisplay dimensions={dimensions} shape={shape} />
												</section>
												<div className="text-muted-foreground">Shape #{index + 1}</div>
											</section>
										</MatrixEditor>
									</CarouselItem>
								);
							})}
						</CarouselContent>
						<CarouselPrevious />
						<CarouselNext />
					</Carousel>
				</section>

				<MatrixEditor
					key={shapes.length}
					onSave={newShape => {
						updateShapes([...shapes, { id: uuid(), shape: newShape }]);
					}}
					dimensions={dimensions}
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
		label: 'Light Emitting Diode (LED) Matrix',
		pins: {
			data: 2,
			clock: 3,
			cs: 4,
		},
		controller: undefined as unknown as string,
		dims: '8x8', // [rows, columns]
		shapes: [DEFAULT_MATRIX_SHAPE],
		devices: 1,
		description: 'Control a LED matrix display to show various shapes',
	} satisfies Props['data'],
};
