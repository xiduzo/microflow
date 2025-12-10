import * as fs from 'fs';
import { transformValueToNumber } from '../_utils/transformUnknownValues';
import { Code } from '../base';
import type { Data, Value } from './audioplayer.types';
import { dataSchema } from './audioplayer.types';
import player from 'play-sound';
import { ChildProcess } from 'child_process';

export class AudioPlayer extends Code<Value, Data> {
	private currentProcess: ChildProcess | null = null;
	private readonly audioPlayer = player();
	private playId = 0;

	constructor(data: Data) {
		super(dataSchema.parse(data), false);
	}

	play(index?: unknown) {
		const filePath = this.data.audioFiles.at(Math.round(transformValueToNumber(index) - 1));
		if (!filePath) return;

		this.playTrack(filePath);
	}

	private playTrack(filePath: string) {
		if (!fs.existsSync(filePath)) return;

		this.stop();

		this.value = true;
		const currentPlayId = ++this.playId;

		this.currentProcess = this.audioPlayer.play(filePath, err => {
			if (currentPlayId === this.playId) this.value = false;
			if (err) return;
			if (!this.data.loop) return;
			if (currentPlayId !== this.playId) return;

			setTimeout(() => {
				this.playTrack(filePath);
			}, 0);
		});
	}

	stop() {
		try {
			this.currentProcess?.kill();
		} catch (error) {
			console.error(error);
		} finally {
			this.currentProcess = null;
			this.value = false;
		}
	}

	destroy() {
		this.stop();
		super.destroy();
	}
}
