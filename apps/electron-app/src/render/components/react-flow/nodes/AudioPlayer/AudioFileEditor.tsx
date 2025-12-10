import {
	Badge,
	Button,
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Empty,
	EmptyContent,
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
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [playingIndex, setPlayingIndex] = useState<number | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const blobUrlRef = useRef<string | null>(null);

	const handleAddFiles = () => {
		fileInputRef.current?.click();
	};

	const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
		const files = event.target.files;
		if (!files || files.length === 0) return;

		const fileArray = Array.from(files);
		const dataUrls: string[] = [];
		let loadedCount = 0;

		fileArray.forEach(file => {
			const reader = new FileReader();
			reader.onload = e => {
				if (e.target?.result) {
					dataUrls.push(e.target.result as string);
					loadedCount++;
					// Update edited files when all files are loaded
					if (loadedCount === fileArray.length) {
						setEditedFiles(prev => [...prev, ...dataUrls]);
					}
				}
			};
			reader.readAsDataURL(file);
		});

		// Reset input so the same file can be selected again
		if (fileInputRef.current) {
			fileInputRef.current.value = '';
		}
	};

	const getFileName = (dataUrl: string, index: number) => {
		const fileName = `Audio file ${index + 1}`;
		try {
			const matches = dataUrl.match(/^data:audio\/([^;]+);base64,(.+)$/);
			if (matches) {
				const mimeType = matches[1].toUpperCase();
				return { fileName, mimeType };
			}
			return { fileName, mimeType: 'unknown' };
		} catch {
			return { fileName, mimeType: 'unknown' };
		}
	};

	const handlePlayPause = (index: number, dataUrl: string) => {
		// If clicking the same audio that's playing, pause it
		if (playingIndex === index && audioRef.current) {
			audioRef.current.pause();
			setPlayingIndex(null);
			audioRef.current = null;
			// Clean up blob URL
			if (blobUrlRef.current) {
				URL.revokeObjectURL(blobUrlRef.current);
				blobUrlRef.current = null;
			}
			return;
		}

		// Stop any currently playing audio
		if (audioRef.current) {
			audioRef.current.pause();
			audioRef.current = null;
		}

		// Clean up previous blob URL
		if (blobUrlRef.current) {
			URL.revokeObjectURL(blobUrlRef.current);
			blobUrlRef.current = null;
		}

		// Try to play the audio - use data URL directly (most reliable)
		const playAudio = (url: string, mimeType: string, isBlob: boolean = false) => {
			const cleanup = () => {
				setPlayingIndex(null);
				audioRef.current = null;
				if (isBlob && blobUrlRef.current) {
					URL.revokeObjectURL(blobUrlRef.current);
					blobUrlRef.current = null;
				}
			};

			const audio = new Audio();
			audioRef.current = audio;
			setPlayingIndex(index);

			// Set up event handlers before setting src
			audio.onended = () => {
				cleanup();
			};

			audio.onerror = e => {
				const error = audio.error;
				console.error('Error playing audio:', {
					error: error?.code,
					message: error?.message,
					mimeType,
					urlType: isBlob ? 'blob' : 'data',
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
					console.error('Error calling play():', error);
					cleanup();
				});
			};

			// Set the source and let it load
			audio.src = url;
			audio.load();

			// Fallback: if canplay doesn't fire, try playing after a short delay
			timeout = setTimeout(() => {
				if (audio.readyState >= 2 && audio.paused) {
					audio.play().catch(error => {
						console.error('Error playing audio (timeout fallback):', error);
						cleanup();
					});
				}
			}, 500);
		};

		// Electron blocks data URLs in media elements for security
		// We need to convert to blob URL instead
		try {
			// Parse the data URL
			const dataUrlMatch = dataUrl.match(/^data:([^;]+)(;base64)?,(.+)$/);
			if (!dataUrlMatch) {
				console.error('Invalid data URL format');
				return;
			}

			const mimeType = dataUrlMatch[1];
			const isBase64 = dataUrlMatch[2] === ';base64';
			const data = dataUrlMatch[3];

			if (!isBase64) {
				console.error('Data URL is not base64 encoded');
				return;
			}

			// Convert base64 to binary
			const binaryString = atob(data);
			const arrayBuffer = new ArrayBuffer(binaryString.length);
			const bytes = new Uint8Array(arrayBuffer);
			for (let i = 0; i < binaryString.length; i++) {
				bytes[i] = binaryString.charCodeAt(i);
			}

			// Create blob and blob URL
			const blob = new Blob([bytes], { type: mimeType });
			const blobUrl = URL.createObjectURL(blob);
			blobUrlRef.current = blobUrl;

			// Play using blob URL (required for Electron)
			playAudio(blobUrl, mimeType, true);
		} catch (error) {
			console.error('Error converting data URL to blob:', error);
		}
	};

	// Cleanup audio on unmount
	useEffect(() => {
		return () => {
			if (audioRef.current) {
				audioRef.current.pause();
				audioRef.current = null;
			}
			if (blobUrlRef.current) {
				URL.revokeObjectURL(blobUrlRef.current);
				blobUrlRef.current = null;
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
						audioRef.current = null;
					}
					if (blobUrlRef.current) {
						URL.revokeObjectURL(blobUrlRef.current);
						blobUrlRef.current = null;
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
					<input
						ref={fileInputRef}
						type='file'
						accept='audio/*'
						multiple
						style={{ display: 'none' }}
						onChange={handleFileSelect}
					/>

					<div className='space-y-2 max-h-96 overflow-y-auto'>
						{editedFiles.map((dataUrl, index) => (
							<Item variant='outline' key={index}>
								<ItemContent>
									<ItemTitle>{getFileName(dataUrl, index).fileName}</ItemTitle>
									<ItemDescription>{getFileName(dataUrl, index).mimeType}</ItemDescription>
								</ItemContent>
								<ItemActions>
									<Button
										variant='outline'
										size='sm'
										onClick={() => handlePlayPause(index, dataUrl)}
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
