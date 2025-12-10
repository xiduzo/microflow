import {
	Button,
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemTitle,
} from '@microflow/ui';
import { useState, useRef, useEffect } from 'react';
import { Icons } from '@microflow/ui';

export function AudioFileEditor(props: Props) {
	const [editedFiles, setEditedFiles] = useState<string[]>(props.audioFiles);
	const [playingIndex, setPlayingIndex] = useState<number | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);

	const handleAddFiles = async () => {
		try {
			const filePaths = await window.electron.ipcRenderer.invoke('ipc-select-audio-files');
			if (filePaths && filePaths.length > 0) {
				setEditedFiles(prev => [...prev, ...filePaths]);
			}
		} catch (error) {
			console.error('Error selecting audio files:', error);
		}
	};

	const getFileName = (filePath: string, index: number) => {
		try {
			// Extract file name from path
			const pathParts = filePath.split(/[/\\]/);
			const fileNameWithExt = pathParts[pathParts.length - 1] || `Audio file ${index + 1}`;

			// Extract extension to determine mime type
			const extension = fileNameWithExt.split('.').pop()?.toLowerCase() || '';
			const mimeTypeMap: Record<string, string> = {
				mp3: 'MP3',
				wav: 'WAV',
				ogg: 'OGG',
				m4a: 'M4A',
				aac: 'AAC',
				flac: 'FLAC',
			};
			const mimeType = mimeTypeMap[extension] || extension.toUpperCase() || 'UNKNOWN';

			// Remove extension from fileName
			const fileName =
				extension && fileNameWithExt.endsWith(`.${extension}`)
					? fileNameWithExt.slice(0, -(extension.length + 1))
					: fileNameWithExt;

			return { fileName, mimeType };
		} catch {
			return { fileName: `Audio file ${index + 1}`, mimeType: 'UNKNOWN' };
		}
	};

	const handlePlayPause = async (index: number, filePath: string) => {
		// If clicking the same audio that's playing, pause it
		if (playingIndex === index && audioRef.current) {
			audioRef.current.pause();
			setPlayingIndex(null);
			audioRef.current = null;
			return;
		}

		// Stop any currently playing audio
		if (audioRef.current) {
			audioRef.current.pause();
			audioRef.current = null;
		}

		let blobUrl: string | null = null;

		const cleanup = () => {
			if (blobUrl) {
				URL.revokeObjectURL(blobUrl);
				blobUrl = null;
			}
			setPlayingIndex(null);
			audioRef.current = null;
		};

		try {
			// Read file via IPC and create blob URL
			const base64Data = await window.electron.ipcRenderer.invoke('ipc-read-audio-file', filePath);

			// Convert base64 to binary
			const binaryString = atob(base64Data);
			const bytes = new Uint8Array(binaryString.length);
			for (let i = 0; i < binaryString.length; i++) {
				bytes[i] = binaryString.charCodeAt(i);
			}

			// Determine MIME type from file extension
			const extension = filePath.split('.').pop()?.toLowerCase() || '';
			const mimeTypeMap: Record<string, string> = {
				mp3: 'audio/mpeg',
				wav: 'audio/wav',
				ogg: 'audio/ogg',
				m4a: 'audio/mp4',
				aac: 'audio/aac',
				flac: 'audio/flac',
			};
			const mimeType = mimeTypeMap[extension] || 'audio/mpeg';

			// Create blob and blob URL
			const blob = new Blob([bytes], { type: mimeType });
			blobUrl = URL.createObjectURL(blob);

			const audio = new Audio();
			audioRef.current = audio;
			setPlayingIndex(index);

			// Set up event handlers before setting src
			audio.onended = () => {
				cleanup();
			};

			audio.onerror = e => {
				const error = audio.error;
				console.warn('Error playing audio:', {
					error: error?.code,
					message: error?.message,
					filePath,
					readyState: audio.readyState,
				});
				cleanup();
			};

			// Fallback timeout in case canplay doesn't fire
			let timeout: NodeJS.Timeout | null = null;

			audio.oncanplay = () => {
				if (timeout) {
					clearTimeout(timeout);
					timeout = null;
				}
				// Audio is ready to play
				audio.play().catch(error => {
					console.warn('Error calling play():', error);
					cleanup();
				});
			};

			// Set the source and let it load
			audio.src = blobUrl;
			audio.load();

			// Fallback: if canplay doesn't fire, try playing after a short delay
			timeout = setTimeout(() => {
				if (audio.readyState >= 2 && audio.paused) {
					audio.play().catch(error => {
						console.warn('Error playing audio (timeout fallback):', { error });
						cleanup();
					});
				}
			}, 500);
		} catch (error) {
			console.warn('Error reading audio file:', error);
			cleanup();
		}
	};

	// Cleanup audio on unmount
	useEffect(() => {
		return () => {
			if (audioRef.current) {
				audioRef.current.pause();
				// Revoke any blob URLs
				if (audioRef.current.src && audioRef.current.src.startsWith('blob:')) {
					URL.revokeObjectURL(audioRef.current.src);
				}
				audioRef.current = null;
			}
		};
	}, []);

	return (
		<Dialog
			open={true}
			onOpenChange={open => {
				if (!open) {
					// Stop any playing audio when closing
					if (audioRef.current) {
						audioRef.current.pause();
						// Revoke any blob URLs
						if (audioRef.current.src && audioRef.current.src.startsWith('blob:')) {
							URL.revokeObjectURL(audioRef.current.src);
						}
						audioRef.current = null;
					}
					setPlayingIndex(null);
					props.onClose();
				}
			}}
		>
			<DialogContent className='max-w-2xl'>
				<DialogHeader>
					<DialogTitle>Manage Audio Files</DialogTitle>
				</DialogHeader>
				<section className='flex flex-col space-y-4'>
					<div className='space-y-2 max-h-96 overflow-y-auto'>
						{editedFiles.map((filePath, index) => (
							<Item variant='outline' key={index}>
								<ItemContent>
									<ItemTitle>{getFileName(filePath, index).fileName}</ItemTitle>
									<ItemDescription>{getFileName(filePath, index).mimeType}</ItemDescription>
								</ItemContent>
								<ItemActions>
									<Button
										variant='outline'
										size='sm'
										onClick={() => handlePlayPause(index, filePath)}
									>
										{playingIndex === index ? <Icons.Pause size={16} /> : <Icons.Play size={16} />}
									</Button>
									<Button
										variant='destructive'
										size='sm'
										onClick={() => {
											setEditedFiles(prev => prev.filter((_, i) => i !== index));
										}}
									>
										<Icons.Trash2 size={16} />
									</Button>
								</ItemActions>
							</Item>
						))}
					</div>
					{editedFiles.length === 0 && (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant='icon'>
									<Icons.Music2Icon />
								</EmptyMedia>
								<EmptyDescription>No audio files selected</EmptyDescription>
							</EmptyHeader>
						</Empty>
					)}

					<Button variant='ghost' onClick={handleAddFiles} className='w-full'>
						<Icons.Plus size={16} />
						Add Audio Files
					</Button>
				</section>
				<DialogFooter>
					<Button
						variant='destructive'
						onClick={() => {
							setEditedFiles([]);
						}}
						disabled={editedFiles.length === 0}
					>
						Clear All
					</Button>
					<DialogClose asChild>
						<Button
							onClick={() => {
								props.onSave({
									audioFiles: editedFiles,
								});
							}}
						>
							Save
						</Button>
					</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type Props = {
	audioFiles: string[];
	onSave: (data: { audioFiles: string[] }) => void;
	onClose: () => void;
};
