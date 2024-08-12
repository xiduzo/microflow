import {
	Button,
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	Icons,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@microflow/ui';
import { useState } from 'react';
import { NOTES_AND_FREQUENCIES } from './constants';

export function NoteSelector(props: {
	value: string;
	onSelect: (value: string | null) => void;
}) {
	const [open, setOpen] = useState(false);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					role="combobox"
					aria-expanded={open}
					className="justify-between w-full"
				>
					{NOTES_AND_FREQUENCIES.get(props.value)
						? props.value
						: props.value === 'null'
							? 'Rest'
							: 'Select note...'}
					<Icons.ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="p-0">
				<Command>
					<CommandInput placeholder="Search note..." />
					<CommandList>
						<CommandEmpty>No framework found.</CommandEmpty>
						<CommandGroup>
							<CommandItem
								value="Rest"
								onSelect={() => {
									props.onSelect(null);
									setOpen(false);
								}}
							>
								Rest
							</CommandItem>
							{Array.from(NOTES_AND_FREQUENCIES.keys()).map(note => (
								<CommandItem
									key={note}
									value={note}
									onSelect={currentValue => {
										props.onSelect(currentValue);
										setOpen(false);
									}}
								>
									{/* <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === framework.value ? "opacity-100" : "opacity-0"
                    )}
                  /> */}
									{note}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
