import { Badge, Label, Slider } from '@fhb/ui';
import { PropsWithChildren, useRef, useState } from 'react';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { MusicSheet } from '../../../MusicSheet';
import { noteDurationToVisualDuation } from './helpers';

export function SongEditor(props: Props) {
	const [editedSong, setEditedSong] = useState(props.song);
	const [editedTempo, setEditedTempo] = useState(props.tempo);

	function swapNotes(id: string, afterId: string) {}

	return (
		<section className="my-6 flex flex-col space-y-4">
			<MusicSheet song={editedSong} />
			<Label htmlFor="temp-tempo" className="flex justify-between">
				Tempo
				<span className="opacity-40 font-light">{editedTempo ?? 100}</span>
			</Label>
			<Slider
				id="temp-tempo"
				defaultValue={[editedTempo ?? 100]}
				min={10}
				max={300}
				step={5}
				onValueChange={value => setEditedTempo(value[0])}
			/>
			<Label>Notes</Label>
			{/* TODO: make this react DND */}
			<DndProvider backend={HTML5Backend}>
				<section className="grid gap-2 grid-cols-4">
					{editedSong.map(([note, duration], index) => (
						<DndBadge
							key={index}
							id={`${note}-${duration}-${index}`}
							swapNotes={swapNotes}
						>
							<span>{note ?? 'Rest'}</span>
							<span className="text-muted-foreground">
								{noteDurationToVisualDuation(duration)}
							</span>
						</DndBadge>
					))}
				</section>
				{/* TODO: add drop area to remove note */}
				{/* TODO: add single note using NoteSelector */}
			</DndProvider>

			{/* <section className="flex flex-col space-y-2">
      {[...editedSong,...editedSong].map(([note, duration], index) => (
        <section key={index} className="grid gap-x-1 grid-cols-4">
          <NoteSelector value={note} onSelect={value => {
            const newSong = [...editedSong]
            newSong[index] = [value, duration]
            setEditedSong(newSong)
          }} />
          <Select onValueChange={value => {
            const newSong = [...editedSong]
            newSong[index] = [note, parseFloat(value)]
            setEditedSong(newSong)
          }}>
            <SelectTrigger>{noteDurationToVisualDuation(duration)}</SelectTrigger>
            <SelectContent>
              {Object.values(NOTE_DURATION).map((selectableDuration) => (
                <SelectItem key={selectableDuration} value={selectableDuration.toString()}>
                  {noteDurationToVisualDuation(selectableDuration)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>
      ))}
    </section> */}
		</section>
	);
}

type Props = {
	song: [string | null, number][];
	tempo: number;
};

function DndBadge(
	props: PropsWithChildren & {
		id: string;
		swapNotes: (id: string, afterId: string) => void;
	},
) {
	const ref = useRef();
	const [{ opacity }, connectDrag] = useDrag(
		() => ({
			type: 'note',
			// item: { text },
			collect: monitor => ({
				opacity: monitor.isDragging() ? 0.5 : 1,
				handlerId: monitor.getHandlerId(),
				isDragging: monitor.isDragging(),
			}),
		}),
		[],
	);

	const [, connectDrop] = useDrop({
		accept: 'note',
		hover({ id }: { id: string; type: string }) {
			if (id !== props.id) {
				props.swapNotes(id, props.id);
			}
		},
	});

	connectDrag(ref);
	connectDrop(ref);

	return (
		<div ref={ref}>
			<Badge
				style={{ opacity }}
				className="flex justify-between"
				variant="secondary"
				draggable
				onClick={() => {
					console.log(
						'TODO: open popover to edit note, can also delete note in popover',
					);
				}}
			>
				{props.children}
			</Badge>
		</div>
	);
}
