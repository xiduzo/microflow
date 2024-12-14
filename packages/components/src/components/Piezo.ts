import JohnnyFive, { PiezoOption, PiezoTune } from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type BuzzData = { type: 'buzz'; duration: number; frequency: number };
export type Note = [string | null, number];
export type SongData = { type: 'song' } & PiezoTune & {
		song: Note[];
	};

export type PiezoData = PiezoOption & (BuzzData | SongData);
export type PiezoValueType = boolean;

export class Piezo extends BaseComponent<PiezoValueType> {
	private readonly component: JohnnyFive.Piezo;
	private timeout: NodeJS.Timeout | undefined;

	constructor(private readonly data: BaseComponentData & PiezoData) {
		super(data, false);
		this.component = new JohnnyFive.Piezo(data);
	}

	buzz() {
		clearTimeout(this.timeout);
		this.stop();

		if (this.data.type !== 'buzz') return;

		this.value = true;
		this.component.frequency(this.data.frequency, this.data.duration);

		this.timeout = setTimeout(() => {
			this.stop();
		}, this.data.duration);
	}

	stop() {
		try {
			this.component.stop();
			this.component.off();
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
		this.component.play(
			{
				song: this.data.song,
				tempo: this.data.tempo,
			},
			() => {
				this.value = false;
			},
		);

		return this;
	}
}
