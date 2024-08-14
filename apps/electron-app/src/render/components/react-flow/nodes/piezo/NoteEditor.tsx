import {
	Button,
	ButtonProps,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from '@microflow/ui';
import { PropsWithChildren, useState } from 'react';
import { NOTE_DURATION } from './constants';
import { noteDurationToVisualDuation } from './helpers';
import { NoteSelector } from './NoteSelector';

export function NodeEditor(props: Props) {
	const [internalNode, setInternalNode] = useState(props.note);
	const [note, duration, id] = internalNode;

	return (
		<Popover>
			<PopoverTrigger>{props.children}</PopoverTrigger>
			<PopoverContent className="space-y-2">
				<NoteSelector
					value={String(note)}
					onSelect={value => {
						setInternalNode([value, duration, id]);
						props.onSelect?.([value, duration, id]);
					}}
				/>
				<Select
					onValueChange={value => {
						setInternalNode([note, Number(value), id]);
						props.onSelect?.([note, Number(value), id]);
					}}
				>
					<SelectTrigger>
						{noteDurationToVisualDuation(Number(duration))}
					</SelectTrigger>
					<SelectContent>
						{Object.values(NOTE_DURATION)
							.filter(duration => {
								if (note === null && duration > 1) return false;
								return duration;
							})
							.map(selectableDuration => (
								<SelectItem
									key={selectableDuration}
									value={selectableDuration.toString()}
								>
									{noteDurationToVisualDuation(selectableDuration)}
								</SelectItem>
							))}
					</SelectContent>
				</Select>
				<Button
					variant={props.action.variant}
					className="w-full"
					onClick={() => props.action.onClick(internalNode)}
				>
					{props.action.label}
				</Button>
			</PopoverContent>
		</Popover>
	);
}

type Props = PropsWithChildren & {
	note: [string, number, string];
	onSelect?: (note: [string | null, number, string]) => void;
	action: Action;
};

type Action = {
	variant?: ButtonProps['variant'];
	label: string;
	onClick: (note: [string | null, number, string]) => void;
};
