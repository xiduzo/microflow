import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { transformValueToBoolean, transformValueToNumber } from '../_utils/transformUnknownValues';
import { Code } from '../base';
import type { Data, Value } from './audioplayer.types';
import { dataSchema } from './audioplayer.types';

// Lazy load play-sound to avoid issues if not installed
let player: any = null;
function getPlayer() {
	if (!player) {
		try {
			player = require('play-sound')({});
		} catch (error) {
			console.error('Failed to load play-sound:', error);
			return null;
		}
	}
	return player;
}

export class AudioPlayer extends Code<Value, Data> {
	private currentProcess: any = null;
	private tempFiles: string[] = [];
	private currentFileIndex: number = 0;

	constructor(data: Data) {
		super(dataSchema.parse(data), false);
		// Create temp files for all audio files upfront
		this.createAllTempFiles();
	}

	private decodeDataUrl(dataUrl: string): { buffer: Buffer; extension: string } | null {
		try {
			// Parse data URL: data:audio/mp3;base64,<base64data>
			const matches = dataUrl.match(/^data:audio\/([^;]+);base64,(.+)$/);
			if (!matches) {
				console.error('Invalid data URL format');
				return null;
			}

			const mimeType = matches[1];
			const base64Data = matches[2];
			const buffer = Buffer.from(base64Data, 'base64');

			// Map MIME types to file extensions
			const extensionMap: Record<string, string> = {
				mp3: 'mp3',
				wav: 'wav',
				ogg: 'ogg',
				m4a: 'm4a',
				aac: 'aac',
				flac: 'flac',
			};

			const extension = extensionMap[mimeType.toLowerCase()] || 'mp3';
			return { buffer, extension };
		} catch (error) {
			console.error('Error decoding data URL:', error);
			return null;
		}
	}

	private createTempFile(dataUrl: string): string | null {
		const decoded = this.decodeDataUrl(dataUrl);
		if (!decoded) return null;

		try {
			const tempDir = os.tmpdir();
			const tempFileName = `audioplayer-${this.id}-${Date.now()}-${Math.random().toString(36).substring(7)}.${decoded.extension}`;
			const tempFilePath = path.join(tempDir, tempFileName);

			fs.writeFileSync(tempFilePath, decoded.buffer);
			return tempFilePath;
		} catch (error) {
			console.error('Error creating temp file:', error);
			return null;
		}
	}

	private createAllTempFiles() {
		this.tempFiles = this.data.audioFiles
			.map(dataUrl => this.createTempFile(dataUrl))
			.filter((filePath): filePath is string => filePath !== null);
	}

	private cleanupTempFiles() {
		this.tempFiles.forEach(filePath => {
			try {
				if (fs.existsSync(filePath)) {
					fs.unlinkSync(filePath);
				}
			} catch (error) {
				console.error(`Error deleting temp file ${filePath}:`, error);
			}
		});
		this.tempFiles = [];
	}

	play(index?: unknown) {
		if (this.tempFiles.length === 0) return;

		// Stop any currently playing audio
		this.stop();

		// If index is provided, use it; otherwise default to 1 (first file)
		// Matrix/Pixel use 1-based indexing, so we subtract 1 to get array index
		const fileIndex = index !== undefined ? Math.round(transformValueToNumber(index) - 1) : 0;

		// Store the current file index for looping
		this.currentFileIndex = fileIndex;

		const tempFilePath = this.tempFiles.at(fileIndex);
		if (!tempFilePath) {
			console.error(`No temp file found for index ${fileIndex}`);
			return;
		}

		const audioPlayer = getPlayer();
		if (!audioPlayer) {
			console.error('Audio player not available');
			return;
		}

		this.value = true;

		// Play the audio file
		this.currentProcess = audioPlayer.play(tempFilePath, (err: Error | null) => {
			if (err) {
				console.error('Error playing audio:', err);
				this.value = false;
				return;
			}

			// Audio finished playing
			this.value = false;

			// Handle looping - replay the same file index
			if (this.data.loop) {
				setTimeout(() => {
					this.play(this.currentFileIndex + 1); // Use 1-based index for play()
				}, 100);
			}
		});
	}

	stop() {
		if (this.currentProcess) {
			try {
				this.currentProcess.kill();
			} catch (error) {
				console.error('Error stopping audio:', error);
			}
			this.currentProcess = null;
		}

		this.value = false;
	}

	destroy() {
		this.stop();
		this.cleanupTempFiles();
		super.destroy();
	}
}
