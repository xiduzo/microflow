import {
	Badge,
	Button,
	Label,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SheetClose,
	SheetFooter,
	Slider,
} from '@microflow/ui';
import {
	createContext,
	PropsWithChildren,
	useContext,
	useEffect,
	useState,
} from 'react';
import { MusicSheet } from '../../../MusicSheet';
import { NOTE_DURATION } from './constants';
import { noteDurationToVisualDuation } from './helpers';
import { NoteSelector } from './NoteSelector';

export function SongEditor(props: Props) {
	const [editedSong, setEditedSong] = useState(
		props.song.map(note => [
			...note,
			Date.now().toString(36) + Math.random().toString(36).substring(2, 9),
		]),
	);
	const [editedTempo, setEditedTempo] = useState(props.tempo);

	function swapNotes(id: string, afterId: string) {
		setEditedSong(prev => {
			const startIndex = prev.findIndex(([_, __, noteId]) => noteId === id);
			const afterIndex = prev.findIndex(
				([_, __, noteId]) => noteId === afterId,
			);
			const newSong = [...prev];
			const [note] = newSong.splice(startIndex, 1);
			newSong.splice(afterIndex, 0, note);
			return newSong;
		});
	}

	return (
		<section className="my-6 flex flex-col space-y-4">
			<MusicSheet song={editedSong as typeof props.song} />
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
			<DragProvider swap={swapNotes}>
				<section className="grid gap-2 grid-cols-4">
					{editedSong.map(([note, duration, id], index) => (
						<Popover key={id}>
							<PopoverTrigger>
								<DndBadge id={id.toString()}>
									<span>{note ?? 'Rest'}</span>
									<span className="text-muted-foreground">
										{noteDurationToVisualDuation(Number(duration))}
									</span>
								</DndBadge>
							</PopoverTrigger>
							<PopoverContent className="space-y-2">
								<NoteSelector
									value={String(note)}
									onSelect={note => {
										setEditedSong(prev => {
											const newSong = [...prev];
											newSong[index][0] = note;
											return newSong;
										});
									}}
								/>
								<Select
									onValueChange={value => {
										const newSong = [...editedSong];
										newSong[index][1] = parseFloat(value);
										setEditedSong(newSong);
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
									variant="destructive"
									className="w-full"
									onClick={() => {
										setEditedSong(prev => {
											const newSong = [...prev];
											newSong.splice(index, 1);
											return newSong;
										});
									}}
								>
									Delete note
								</Button>
							</PopoverContent>
						</Popover>
					))}
					<Badge
						variant="outline"
						className="border-dashed hover:cursor-pointer hover:border-solid justify-center"
						onClick={() => {
							setEditedSong(prev => [
								...prev,
								[
									null,
									NOTE_DURATION.Whole,
									Date.now().toString(36).substring(2, 9),
								],
							]);
						}}
					>
						Add note
					</Badge>
				</section>
			</DragProvider>
			<SheetFooter>
				<SheetClose asChild>
					<Button variant="secondary">Cancel</Button>
				</SheetClose>
				<SheetClose asChild>
					<Button
						onClick={() => {
							props.onSave(
								editedSong.map(([note, duration]) => [
									note,
									duration,
								]) as typeof props.song,
								editedTempo,
							);
						}}
					>
						Save song
					</Button>
				</SheetClose>
			</SheetFooter>
		</section>
	);
}

type Props = {
	song: [string | null, number][];
	tempo: number;
	onSave: (song: [string | null, number][], tempo: number) => void;
};

function DndBadge(props: PropsWithChildren & { id: string }) {
	const { dragging, setDragging, setHover } = useDrag();
	return (
		<Badge
			style={{ opacity: dragging === props.id ? 0.25 : 1 }}
			draggable
			onDragStart={setDragging(props.id)}
			onDragEnd={setDragging('')}
			onDragEnter={setHover(props.id)}
			onDragLeave={setHover('')}
			onDrop={() => {
				setDragging('');
				setHover('');
			}}
			className="flex justify-between hover:cursor-grab"
			variant="secondary"
		>
			{props.children}
		</Badge>
	);
}

const DragContext = createContext({
	dragging: '',
	setDragging: (id: string) => () => {},
	setHover: (id: string) => () => {},
});

function DragProvider(
	props: PropsWithChildren & { swap: (id: string, afterId: string) => void },
) {
	const [dragging, internalSetDragging] = useState('');
	const [hover, internalSetHover] = useState('');

	const setDragging = (id: string) => () => {
		internalSetDragging(id);
	};

	const setHover = (id: string) => () => {
		internalSetHover(id);
	};

	useEffect(() => {
		if (dragging === '' || hover === '') {
			return;
		}

		if (dragging === hover) {
			return;
		}

		internalSetHover('');
		props.swap(dragging, hover);
	}, [dragging, hover, props.swap]);

	return (
		<DragContext.Provider
			value={{
				dragging,
				setDragging,
				setHover,
			}}
		>
			{props.children}
		</DragContext.Provider>
	);
}

function useDrag() {
	return useContext(DragContext);
}
