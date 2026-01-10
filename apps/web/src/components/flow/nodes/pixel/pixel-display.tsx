import { Icons } from '@microflow/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui/components/ui/tooltip';
import { useMemo } from 'react';
import type { Value } from '@microflow/runtime/src/pixel/pixel.types';
import { DEFAULT_OFF_PIXEL_COLOR } from '@microflow/runtime/src/pixel/pixel.constants';

const LEDS_PER_ROW = 8;
const totalCols = LEDS_PER_ROW + 1; // +1 for the icon column

type GridItem = { index: number; row: number; col: number };

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

type Props = {
	value: Value;
	length: number;
	showLabel?: boolean;
	onPixelClick?: (index: number) => void;
	selectedPixel?: number | null;
};

export function PixelDisplay({
	value,
	length,
	showLabel = false,
	onPixelClick,
	selectedPixel,
}: Props) {
	const gridItems = useMemo(() => createSnakeLayout(length), [length]);

	// Ensure value array matches length
	const paddedValue = useMemo(() => {
		return Array.from({ length }, (_, i) => value[i] || DEFAULT_OFF_PIXEL_COLOR);
	}, [value, length]);

	return (
		<section className={showLabel ? 'px-12' : ''}>
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

					const color = paddedValue[item.index] || DEFAULT_OFF_PIXEL_COLOR;
					const isSelected = selectedPixel === item.index;
					const isClickable = !!onPixelClick;

					const pixelElement = (
						<div
							className={`size-4 rounded-full transition-all ${
								isClickable
									? `hover:ring-2 hover:ring-blue-500 hover:ring-offset-1 cursor-pointer ${
											isSelected ? 'ring-2 ring-blue-500 ring-offset-1' : ''
										}`
									: ''
							}`}
							style={{
								backgroundColor: color,
								gridRow: item.row + 1,
								gridColumn: item.col + 1,
							}}
							onClick={isClickable ? () => onPixelClick?.(item.index) : undefined}
						/>
					);

					if (isClickable) {
						return (
							<Tooltip key={item.index}>
								<TooltipTrigger asChild>{pixelElement}</TooltipTrigger>
								<TooltipContent>
									Pixel {item.index + 1}: {color}
								</TooltipContent>
							</Tooltip>
						);
					}

					return (
						<Tooltip key={item.index}>
							<TooltipTrigger asChild>{pixelElement}</TooltipTrigger>
							<TooltipContent>
								LED {item.index + 1}: {color}
							</TooltipContent>
						</Tooltip>
					);
				})}
			</div>
			{showLabel && (
				<div className='text-xs text-center text-muted-foreground mt-2'>{`${paddedValue.length} LEDs`}</div>
			)}
		</section>
	);
}
