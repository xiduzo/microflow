import JohnnyFive from 'johnny-five';
import { Hardware } from '../base';
import type { Data, Value } from './piezo.types';
import { dataSchema } from './piezo.types';

export class Piezo extends Hardware<Value, Data, JohnnyFive.Piezo> {
	private timeout: NodeJS.Timeout | undefined;

	constructor(data: Data) {
		super(dataSchema.parse(data), false);
	}

	buzz() {
		clearTimeout(this.timeout);
		this.stop();

		if (this.data.type !== 'buzz') return;

		this.value = true;
		this.component?.frequency(this.data.frequency, this.data.duration);

		this.timeout = setTimeout(() => {
			this.stop();
		}, this.data.duration);
	}

	stop() {
		try {
			this.component?.stop();
			this.component?.off();
			this.value = false;
		} catch (error) {
			console.error(error);
		}
		return this;
	}

	play() {
		this.stop();

		if (this.data.type !== 'song') return;

		this.value = true;
		this.component?.play(
			{
				song: this.data.song,
				tempo: this.data.tempo,
			},
			() => {
				this.value = false;
			}
		);

		return this;
	}

	protected createComponent(data: Data) {
		this.component = new JohnnyFive.Piezo(data);
		return this.component;
	}
}
