import {
	Button,
	cva,
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	ScrollArea,
} from '@microflow/ui';
import { Position } from '@xyflow/react';
import { Led } from 'johnny-five';
import { Handle } from '../Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
} from '../Node';
import { MatrixDisplay } from './MatrixDisplay';
import { MatrixEditor } from './MatrixEditor';

export function Matrix(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue>
					<MatrixDisplay
						size="small"
						dimensions={[8, 8]}
						shape={DEFAULT_MATRIX_SHAPE}
					/>
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<ScrollArea className="h-96 p-4 border">
					<section className="grid grid-cols-12 gap-2">
						{Array.from({ length: 24 }).map((_, index) => {
							return (
								<Dialog key={index}>
									<DialogTrigger asChild>
										<div
											className={shape({
												cols: (12 / Math.round(32 / 8)) as keyof typeof shape,
											})}
										>
											<MatrixDisplay
												size="tiny"
												dimensions={[8, 8]}
												shape={DEFAULT_MATRIX_SHAPE}
											/>
										</div>
									</DialogTrigger>
									<DialogContent>
										<DialogHeader>
											<DialogTitle>Edit shape</DialogTitle>
										</DialogHeader>
										<MatrixEditor
											dimensions={[8, 8]}
											shape={DEFAULT_MATRIX_SHAPE}
										/>
										<DialogFooter className="gap-2 sm:gap-0">
											<DialogClose asChild>
												<Button variant="destructive">Delete shape</Button>
											</DialogClose>
											<DialogClose asChild>
												<Button>Save shape</Button>
											</DialogClose>
										</DialogFooter>
									</DialogContent>
								</Dialog>
							);
						})}
					</section>
				</ScrollArea>
			</NodeSettings>
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

const shape = cva(
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

export type MatrixShape = string[];
export type MatrixData = Omit<
	Led.MatrixOption & Led.MatrixIC2Option,
	'board'
> & {
	shapes: MatrixShape[];
};

type Props = BaseNode<MatrixData, any>;
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

export const DEFAULT_MATRIX_DATA: Props['data'] = {
	value: false,
	label: 'LED Matrix',
	pins: {
		data: 8,
		clock: 10,
		cs: 4,
	},
	controller: undefined,
	dims: [8, 8], // [rows, columns]
	shapes: [DEFAULT_MATRIX_SHAPE],
};
