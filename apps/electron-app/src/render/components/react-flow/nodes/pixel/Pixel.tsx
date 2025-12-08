import { type Data, type Value, dataSchema } from '@microflow/runtime/src/pixel/pixel.types';
import { COLORS, DEFAULT_OFF_PIXEL_COLOR } from '@microflow/runtime/src/pixel/pixel.constants';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from '../Node';
import { Handle } from '../../Handle';
import { Position } from '@xyflow/react';
import { usePins } from '../../../../stores/board';
import { MODES } from '../../../../../common/types';
import { reducePinsToOptions } from '../../../../../common/pin';
import { useNodeValue } from '../../../../stores/node-data';
import { folder, button } from 'leva';
import {
	Icons,
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
} from '@microflow/ui';
import { useState, useMemo } from 'react';
import { PixelEditor } from './PixelEditor';
import { PixelDisplay } from './PixelDisplay';

// Create a simple hash for the preset to use as a key
function presetKey(preset: Value, index: number): string {
	return `preset-${index}-${JSON.stringify(preset)}`;
}

export function Pixel(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle
				type='target'
				position={Position.Left}
				id='show'
				hint='shows preset #'
				offset={-1.5}
			/>
			<Handle
				type='target'
				position={Position.Left}
				id='color'
				hint='array of hex colors'
				offset={-0.5}
			/>
			<Handle
				type='target'
				position={Position.Left}
				id='move'
				hint='moves the pixel strip by # pixels'
				offset={0.5}
			/>
			<Handle type='target' position={Position.Left} id='turnOff' title='off' offset={1.5} />
			<Handle type='source' position={Position.Right} id='change' />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<Data>();
	const value = useNodeValue<Value>(Array(data.length).fill(DEFAULT_OFF_PIXEL_COLOR));

	return <PixelDisplay value={value} length={data.length} showLabel />;
}

function Settings() {
	const data = useNodeData<Data>();
	const pins = usePins([MODES.OUTPUT], [MODES.ANALOG]);
	const [editorOpened, setEditorOpened] = useState(false);
	const [presets, setPresets] = useState<Value[]>(data.presets ?? [[]]);

	const { render, setNodeData } = useNodeControls({
		pin: {
			value: data.pin,
			options: pins.reduce(reducePinsToOptions, {}),
			label: 'pin',
		},
		length: {
			value: data.length,
			min: 1,
			max: 144,
			step: 1,
		},
		'edit presets': button(() => setEditorOpened(true)),
		advanced: folder(
			{
				gamma: {
					value: data.gamma,
					min: 0,
					max: 10,
					step: 0.1,
				},
				color_order: {
					value: data.color_order,
					label: 'color order',
					hint: 'The order of the colors in the pixel strip',
					options: COLORS,
				},
			},
			{ collapsed: true }
		),
	});

	function updatePresets(newPresets: Value[]) {
		setPresets(newPresets);
		data.presets = newPresets;
		setNodeData(data);
	}

	function swapPresets(left: number, right: number) {
		const nextPresets = [...presets];
		nextPresets[left] = presets[right];
		nextPresets[right] = presets[left];
		updatePresets(nextPresets);
	}

	return (
		<>
			{render()}
			{editorOpened && (
				<Dialog defaultOpen onOpenChange={setEditorOpened}>
					<DialogContent className='max-w-screen-md'>
						<DialogHeader>
							<DialogTitle>Presets</DialogTitle>
							<DialogDescription>
								When showing a preset the input handle will round to the closest preset number
							</DialogDescription>
						</DialogHeader>
						<section className='flex items-center justify-center'>
							<Carousel className='w-full max-w-xl'>
								<CarouselContent>
									{presets.map((preset, index) => {
										return (
											<CarouselItem
												key={index}
												className='flex flex-col items-center gap-3 cursor-grab active:cursor-grabbing'
											>
												<PixelEditor
													key={presetKey(preset, index)}
													length={data.length}
													preset={preset}
													onSave={newPreset => {
														const nextPresets = [...presets];
														nextPresets[index] = newPreset;
														updatePresets(nextPresets);
													}}
													onDelete={() => {
														const nextPresets = [...presets];
														nextPresets.splice(index, 1);
														updatePresets(nextPresets);
													}}
												>
													<section className='flex-col flex items-center justify-center'>
														<section className='max-w-xl overflow-x-scroll pb-8'>
															<PixelDisplay value={preset} length={data.length} />
														</section>
													</section>
												</PixelEditor>
												<section className='text-muted-foreground flex gap-20 items-center'>
													<Button
														variant='outline'
														disabled={index === 0 || index - 1 < 0}
														onClick={() => swapPresets(index - 1, index)}
													>
														<Icons.ArrowLeftRight /> Swap
													</Button>
													<div>
														Preset #{index + 1} of {presets.length}
													</div>
													<Button
														variant='outline'
														disabled={index === presets.length - 1 || index + 1 >= presets.length}
														onClick={() => swapPresets(index, index + 1)}
													>
														Swap
														<Icons.ArrowRightLeft />
													</Button>
												</section>
											</CarouselItem>
										);
									})}
								</CarouselContent>
								<CarouselPrevious />
								<CarouselNext />
							</Carousel>
						</section>
						<PixelEditor
							key={presets.length}
							onSave={newPreset => updatePresets([...presets, newPreset])}
							length={data.length}
							preset={[]}
						>
							<Button variant='outline'>Add new preset</Button>
						</PixelEditor>
					</DialogContent>
				</Dialog>
			)}
		</>
	);
}

type Props = BaseNode<Data>;
Pixel.defaultProps = {
	data: {
		...dataSchema.parse({}),
		group: 'hardware',
		tags: ['output', 'analog'],
		label: 'LED Strip',
		icon: 'RainbowIcon',
		description: 'Control a strip of addressable RGB LEDs (WS2812, NeoPixel, etc.)',
	} satisfies Props['data'],
};
