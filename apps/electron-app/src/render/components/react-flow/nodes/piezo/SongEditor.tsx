import {
	Badge,
	Button,
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@microflow/ui';
import { useState } from 'react';
import { DragProvider } from '../../../../providers/DragProvider';
import { MusicSheet } from '../../../MusicSheet';
import { DEFAULT_NOTE, DEFAULT_NOTE_DURATION } from './constants';
import { DndBadge } from './DndBadge';
import { noteDurationToVisualDuation } from './helpers';
import { NodeEditor } from './NoteEditor';

function randomNodeId() {
	return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

function addIdToSong(song: Props['song']): [string | null, number, string][] {
	return song.map(([note, duration]) => [note, duration, randomNodeId()]);
}

export function SongEditor(props: Props) {
	const [editedSong, setEditedSong] = useState<
		[string | null, number, string][]
	>(addIdToSong(props.song));

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
		<Dialog
			onOpenChange={() => {
				setEditedSong(addIdToSong(props.song));
			}}
		>
			<DialogTrigger asChild>
				<Button variant="outline">Edit song</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Edit song</DialogTitle>
				</DialogHeader>
				<section className="flex flex-col space-y-4">
					<MusicSheet song={editedSong as any as typeof props.song} />
					<DragProvider swap={swapNotes}>
						<section className="grid gap-2 grid-cols-4">
							{editedSong?.map((note, index) => (
								<NodeEditor
									key={note[2]}
									note={note}
									onSelect={value => {
										setEditedSong(prev => {
											const newSong = [...prev];
											newSong[index] = value;
											return newSong;
										});
									}}
									action={{
										label: 'Delete note',
										variant: 'destructive',
										onClick: () => {
											setEditedSong(prev => {
												const newSong = [...prev];
												newSong.splice(index, 1);
												return newSong;
											});
										},
									}}
								>
									<DndBadge id={note[0]}>
										<span>{note[0] ?? 'Rest'}</span>
										<span className="text-muted-foreground">
											{noteDurationToVisualDuation(note[1])}
										</span>
									</DndBadge>
								</NodeEditor>
							))}
							<NodeEditor
								key={randomNodeId()}
								note={[DEFAULT_NOTE, DEFAULT_NOTE_DURATION, randomNodeId()]}
								action={{
									label: 'Add note',
									onClick: note => {
										setEditedSong(prev => {
											return [...prev, note];
										});
									},
								}}
							>
								<Badge
									variant="outline"
									className="border-dashed hover:cursor-pointer hover:border-solid justify-center w-full h-full"
								>
									Add note
								</Badge>
							</NodeEditor>
						</section>
					</DragProvider>
					<DialogFooter>
						<DialogClose asChild>
							<Button
								onClick={() => {
									props.onSave({
										song: editedSong.map(([note, duration]) => [
											note,
											duration,
										]) as typeof props.song,
									});
								}}
							>
								Save song
							</Button>
						</DialogClose>
					</DialogFooter>
				</section>
			</DialogContent>
		</Dialog>
	);
}

type Props = {
	song: [string | null, number][];
	onSave: (data: { song: [string | null, number][] }) => void;
};
