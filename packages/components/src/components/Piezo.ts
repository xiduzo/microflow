import JohnnyFive from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type PiezoOptions = BaseComponentOptions<boolean> & {
	frequency: number;
	duration: number;
	tempo: number;
	song: [string | null, number][];
} & JohnnyFive.PiezoOption;

export class Piezo extends BaseComponent<boolean> {
	private readonly component: JohnnyFive.Piezo;

	constructor(private readonly options: PiezoOptions) {
		super(options);
		this.component = new JohnnyFive.Piezo(options);
	}

	buzz() {
		this.stop();

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
