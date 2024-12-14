import { BaseComponent, BaseComponentOptions } from './BaseComponent';
/**
 * Function generator is a very versatile way of doing things in mcus
 * it can be used to control timing as well as values. For example a
 * square wave can be used to control on/off cycles of an LED at a
 * specific frequency. As well as values, such as using a
 * sine wave to control a fade value.
 *
 * Function generators can be compounded to produce interesting control signals.
 */
export type WaveformType = 'sinus' | 'square' | 'sawtooth' | 'triangle' | 'random';

export type OscillatorData = {
	waveform: WaveformType;
	period: number;
	amplitude: number;
	phase: number;
	shift: number;
	// autoStart?: boolean;
};
export type OscillatorValueType = number;

type OscillatorOptions = BaseComponentOptions & OscillatorData;

export class Oscillator extends BaseComponent<OscillatorValueType> {
	// user-defined values through the options panel
	// private waveform: WaveformType = 'sinus';
	// private period: number = 1;
	// private amplitude: number = 1;
	// private phase: number = 0;
	// private shift: number = 0;

	// auto-calculated values when "period" is reset
	private freq1: number = 0;
	private freq2: number = 0;
	private freq4: number = 0;
	private freq0: number = 0;

	// internal logic
	private started: number = 0;
	private refreshRate: number = 20; /* default to 50 times a second */
	private interval: NodeJS.Timeout | null = null;

	constructor(private readonly options: OscillatorOptions) {
		super(options, 0);

		// console.log('oscillator was recreated!');
		// console.log(options);
		// console.log('---------------------------');
		// console.log(this);

		this.freq1 = 1 / this.options.period;
		this.freq2 = 2 * this.freq1;
		this.freq4 = 4 * this.freq1;
		this.freq0 = 2 * Math.PI * this.freq1;

		this.started = Date.now();

		this.start();
	}

	public reset() {
		this.started = Date.now();
	}

	private elapsed(): number {
		//return Date.now() - this.started;
		return performance.now();
	}

	private sawtooth(t: number): number {
		let rv: number = 0;

		t += this.options.phase;
		if (t >= 0.0) {
			if (t >= this.options.period) t = t % this.options.period;
			rv = this.options.amplitude * (-1.0 + t * this.freq2);
		} else {
			t = -t;
			if (t >= this.options.period) t = t % this.options.period;
			rv = this.options.amplitude * (1.0 - t * this.freq2);
		}
		rv += this.options.shift;
		return rv;
	}

	private triangle(t: number): number {
		let rv: number = 0;

		t += this.options.phase;
		if (t < 0.0) {
			t = -t;
		}
		if (t >= this.options.period) t = t % this.options.period;
		if (t * 2 < this.options.period) {
			rv = this.options.amplitude * (-1.0 + t * this.freq4);
		} else {
			rv = this.options.amplitude * (3.0 - t * this.freq4);
		}
		rv += this.options.shift;
		return rv;
	}

	private square(t: number): number {
		let rv: number = 0;
		t += this.options.phase;
		if (t >= 0) {
			if (t >= this.options.period) t = t % this.options.period;
			if (t + t < this.options.period) rv = this.options.amplitude;
			else rv = -this.options.amplitude;
		} else {
			t = -t;
			if (t >= this.options.period) t = t % this.options.period;
			if (t * 2 < this.options.period) rv = -this.options.amplitude;
			else rv = this.options.amplitude;
		}
		rv += this.options.shift;
		return rv;
	}

	private sinus(t: number): number {
		let rv: number;
		t += this.options.phase;
		rv = this.options.amplitude * Math.sin(t * this.freq0);
		rv += this.options.shift;
		return rv;
	}

	private random(t: number /* not used */): number {
		let rv: number = this.options.shift + this.options.amplitude * Math.random();
		return rv;
	}

	start() {
		// avoid multiple re-entry
		if (this.interval) {
			clearInterval(this.interval);
		}

		this.interval = setInterval(() => {
			switch (this.options.waveform) {
				case 'sinus': {
					// console.log(`oscillator >> sinus`);
					this.value = this.sinus(this.elapsed());
					break;
				}
				case 'square': {
					// console.log(`oscillator >> square`);
					this.value = this.square(this.elapsed());
					break;
				}
				case 'sawtooth': {
					// console.log(`oscillator >> sawtooth`);
					this.value = this.sawtooth(this.elapsed());
					break;
				}
				case 'triangle': {
					// console.log(`oscillator >> triangle`);
					this.value = this.triangle(this.elapsed());
					break;
				}
				case 'random': {
					// console.log(`oscillator >> random`);
					this.value = this.random(this.elapsed());
					break;
				}
			}
		}, this.refreshRate);
	} // start()

	stop() {
		if (this.interval) {
			clearInterval(this.interval);
		}
	}
}
