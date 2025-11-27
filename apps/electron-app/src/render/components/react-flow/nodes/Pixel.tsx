import { type Data, type Value, dataSchema } from '@microflow/runtime/src/pixel/pixel.types';
import { COLORS } from '@microflow/runtime/src/pixel/pixel.constants';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';
import { usePins } from '../../../stores/board';
import { MODES } from '../../../../common/types';
import { reducePinsToOptions } from '../../../../common/pin';
import { useNodeValue } from '../../../stores/node-data';
import { folder } from 'leva';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui/components/ui/tooltip';
import { Icons } from '@microflow/ui';
import { useMemo } from 'react';

export function Pixel(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='forward' offset={-1.5} />
			<Handle
				type='target'
				position={Position.Left}
				id='color'
				hint='array of hex colors'
				offset={-0.5}
			/>
			<Handle type='target' position={Position.Left} id='backward' offset={0.5} />
			<Handle type='target' position={Position.Left} id='turnOff' offset={1.5} />
			<Handle type='source' position={Position.Right} id='change' />
		</NodeContainer>
	);
}

type GridItem = { index: number; row: number; col: number };

const LEDS_PER_ROW = 8;
const totalCols = LEDS_PER_ROW + 1; // +1 for the icon column

function createSnakeLayout(length: number): GridItem[] {
	const gridItems: GridItem[] = [];

	let ledIndex = 0;
	let currentRow = 0;

	if (ledIndex < length) {
		gridItems.push({ index: -1, row: currentRow, col: 0 }); // Icon
		for (let i = 0; i < LEDS_PER_ROW - 1 && ledIndex < length; i++) {
			gridItems.push({ index: ledIndex, row: currentRow, col: i + 1 });
			ledIndex++;
		}
		currentRow++;

		// Single LED on the right after first row
		if (ledIndex < length) {
			gridItems.push({
				index: ledIndex,
				row: currentRow,
				col: LEDS_PER_ROW - 1,
			});
			ledIndex++;
			currentRow++;
		}
	}

	// Continue with snake pattern: full row, then single LED, then full row, etc.
	let goingRightToLeft = true; // After first row, next full row goes right-to-left
	while (ledIndex < length) {
		if (goingRightToLeft) {
			// Full row: right to left (8 LEDs)
			const rowLength = Math.min(LEDS_PER_ROW, length - ledIndex);
			for (let i = 0; i < rowLength; i++) {
				const col = LEDS_PER_ROW - 1 - i;
				gridItems.push({ index: ledIndex, row: currentRow, col });
				ledIndex++;
			}
			currentRow++;
			goingRightToLeft = false;

			// Single LED on the left after right-to-left row
			if (ledIndex < length) {
				gridItems.push({ index: ledIndex, row: currentRow, col: 0 });
				ledIndex++;
				currentRow++;
			}
		} else {
			// Full row: left to right (8 LEDs)
			const rowLength = Math.min(LEDS_PER_ROW, length - ledIndex);
			for (let i = 0; i < rowLength; i++) {
				gridItems.push({ index: ledIndex, row: currentRow, col: i });
				ledIndex++;
			}
			currentRow++;
			goingRightToLeft = true;

			// Single LED on the right after left-to-right row
			if (ledIndex < length) {
				gridItems.push({
					index: ledIndex,
					row: currentRow,
					col: LEDS_PER_ROW - 1,
				});
				ledIndex++;
				currentRow++;
			}
		}
	}

	return gridItems;
}

function Value() {
	const data = useNodeData<Data>();
	const value = useNodeValue<Value>(Array(data.length).fill('#000000'));

	const gridItems = useMemo(() => createSnakeLayout(data.length), [data.length]);

	return (
		<section className='px-12'>
			<div
				className='grid gap-0.5'
				style={{
					gridTemplateColumns: `repeat(${totalCols - 1}, 1rem)`,
					width: 'fit-content',
					margin: '0 auto',
				}}
			>
				{gridItems.map(item => {
					if (item.index === -1) {
						return (
							<div
								key='icon'
								className='flex items-center justify-center'
								style={{ gridRow: item.row + 1, gridColumn: item.col + 1 }}
							>
								<Icons.ChevronRight className='size-4 text-muted-foreground' />
							</div>
						);
					}

					const color = value[item.index] || '#000000';
					return (
						<Tooltip key={item.index}>
							<TooltipTrigger asChild>
								<div
									className='size-4 rounded-full'
									style={{
										backgroundColor: color,
										gridRow: item.row + 1,
										gridColumn: item.col + 1,
									}}
								/>
							</TooltipTrigger>
							<TooltipContent>
								LED {item.index + 1}: {color}
							</TooltipContent>
						</Tooltip>
					);
				})}
			</div>
			<div className='text-xs text-center text-muted-foreground mt-2'>{`${value.length} LEDs`}</div>
		</section>
	);
}

function Settings() {
	const data = useNodeData<Data>();
	const pins = usePins([MODES.OUTPUT], [MODES.ANALOG]);

	const { render } = useNodeControls({
		data: {
			value: data.data,
			options: pins.reduce(reducePinsToOptions, {}),
			label: 'pin',
		},
		length: {
			value: data.length,
			min: 1,
			max: 144,
			step: 1,
		},
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

	return <>{render()}</>;
}

type Props = BaseNode<Data>;
Pixel.defaultProps = {
	data: {
		...dataSchema.parse({}),
		group: 'hardware',
		tags: ['output', 'analog'],
		label: 'Pixel',
		icon: 'ZapIcon',
		description: 'Control a strip of addressable RGB LEDs (WS2812, NeoPixel, etc.)',
	} satisfies Props['data'],
};
