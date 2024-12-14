import {
	Badge,
	Button,
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@microflow/ui';
import { useState } from 'react';
import { uuid } from '../../../../../utils/uuid';
import { DragAndDropProvider } from '../../../../providers/DragAndDropProvider';
import { MusicSheet } from '../../../MusicSheet';
import { DEFAULT_NOTE, DEFAULT_NOTE_DURATION } from './constants';
import { DndBadge } from './DndBadge';
import { noteDurationToVisualDuation } from './helpers';
import { NodeEditor } from './NoteEditor';

export function SongEditor(props: Props) {
	const [editedSong, setEditedSong] = useState(props.song.map(note => ({ note, id: uuid() })));

	function swapNotes(id: string, hoveredId: string) {
		setEditedSong(prev => {
			const leftIndex = prev.findIndex(item => item.id === id);
			const rightIndex = prev.findIndex(item => item.id === hoveredId);
			const newSong = [...prev];
			newSong[leftIndex] = prev[rightIndex];
			newSong[rightIndex] = prev[leftIndex];
			return newSong;
		});
	}

	return (
		<Dialog defaultOpen onOpenChange={props.onClose}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Edit song</DialogTitle>
				</DialogHeader>
				<section className="flex flex-col space-y-4">
					<MusicSheet song={editedSong.map(song => song.note)} />
					<DragAndDropProvider swap={swapNotes}>
						<section className="grid gap-2 grid-cols-4">
							{editedSong?.map(({ note, id }, index) => (
								<NodeEditor
									key={id}
									note={note}
									onSelect={value => {
										setEditedSong(prev => {
											const newSong = [...prev];
											newSong[index] = { ...newSong[index], note: value };
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
									<DndBadge id={id}>
										<span>{note[0] ?? 'Rest'}</span>
										<span className="text-muted-foreground">
											{noteDurationToVisualDuation(note[1])}
										</span>
									</DndBadge>
								</NodeEditor>
							))}
							<NodeEditor
								note={[DEFAULT_NOTE, DEFAULT_NOTE_DURATION]}
								action={{
									label: 'Add note',
									onClick: note => {
										setEditedSong(prev => {
											return [...prev, { note, id: uuid() }];
										});
									},
								}}
							>
								<Badge
									variant="outline"
									className="text-muted-foreground hover:text-foreground border-dashed hover:cursor-pointer hover:border-solid justify-center w-full h-full"
								>
									Add note
								</Badge>
							</NodeEditor>
						</section>
					</DragAndDropProvider>
					<DialogFooter>
						<Button
							variant="destructive"
							onClick={() => {
								setEditedSong([]);
							}}
						>
							Clear song
						</Button>
						<DialogClose asChild>
							<Button
								onClick={() => {
									props.onSave({
										song: editedSong.map(({ note }) => note),
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
	onClose: () => void;
};
