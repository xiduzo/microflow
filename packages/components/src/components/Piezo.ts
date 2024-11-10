import JohnnyFive, { PiezoOption, PiezoTune } from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type BuzzData = { type: 'buzz'; duration: number; frequency: number };
export type Note = [string | null, number];
export type SongData = { type: 'song' } & PiezoTune & {
		song: Note[];
	};

export type PiezoData = PiezoOption & (BuzzData | SongData);
export type PiezoValueType = boolean;

type PiezoOptions = BaseComponentOptions & PiezoData;

export class Piezo extends BaseComponent<PiezoValueType> {
	private readonly component: JohnnyFive.Piezo;

	constructor(private readonly options: PiezoOptions) {
		super(options, false);
		this.component = new JohnnyFive.Piezo(options);
	}

	buzz() {
		this.stop();

		if (this.options.type !== 'buzz') {
			return;
		}

		this.value = true;
		this.component.frequency(this.options.frequency, this.options.duration);

		setTimeout(() => {
			this.stop();
		}, this.options.duration);
	}

	stop() {
		this.component.stop();
		this.component.off();
		this.value = false;
		return this;
	}

	play() {
		this.stop();

		if (this.options.type !== 'song') {
			return;
		}

		this.value = true;
		this.component.play(
			{
				song: this.options.song,
				tempo: this.options.tempo,
			},
			() => {
				this.value = false;
			},
		);

		return this;
	}
}
