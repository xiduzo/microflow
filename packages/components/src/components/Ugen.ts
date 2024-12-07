import { BaseComponent, BaseComponentOptions } from './BaseComponent';
/**
 * Function generator is a very versatile way of doing things in MCUs
 * it can be used to control timing, for example a square wave can be used
 * to control on/off cycles of an LED. As well as values, such as using a
 * sine wave to control a face value. Function generator can be compounded
 * to produce fairly complex control signals.
 */
export type WaveformType = 'sinus' | 'square' | 'sawtooth' | 'triangle' | 'random';

export type UgenData = {
	waveform: WaveformType;
	period: number;
	amplitude: number;
	phase: number;
	shift: number;
	autoStart?: boolean;
};
export type UgenValueType = number;

type UgenOptions = BaseComponentOptions & UgenData;

export class Ugen extends BaseComponent<UgenValueType> {
	// user-defined values through the options panel
	private waveform: WaveformType = 'sinus';
	private period: number = 1;
	private amplitude: number = 1;
	private phase: number = 0;
	private shift: number = 0;

	// auto-calculated values when "period" is reset
	private freq1: number = 0;
	private freq2: number = 0;
	private freq4: number = 0;
	private freq0: number = 0;

	private started: number = 0;

	constructor(private readonly options: UgenOptions) {
		super(options, 0);

		this.freq1 = 1 / this.period;
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
		return Date.now() - this.started;
	}

	private sawtooth(t: number /*, mode: number */): number {
		let rv: number = 0;

		t += this.phase;
		if (t >= 0.0) {
			if (t >= this.period) t = t % this.period;
			//if (mode == 1) t = this.period - t;
			rv = this.amplitude * (-1.0 + t * this.freq2);
		} else {
			t = -t;
			if (t >= this.period) t = t % this.period;
			//if (mode == 1) t = this.period - t;
			rv = this.amplitude * (1.0 - t * this.freq2);
		}
		rv += this.shift;
		return rv;
	}

	private triangle(t: number): number {
		let rv: number = 0;

		t += this.phase;
		if (t < 0.0) {
			t = -t;
		}
		if (t >= this.period) t = t % this.period;
		if (t * 2 < this.period) {
			rv = this.amplitude * (-1.0 + t * this.freq4);
		} else {
			rv = this.amplitude * (3.0 - t * this.freq4);
		}
		rv += this.shift;
		return rv;
	}

	private square(t: number): number {
		let rv: number = 0;
		t += this.phase;
		if (t >= 0) {
			if (t >= this.period) t = t % this.period;
			if (t + t < this.period) rv = this.amplitude;
			else rv = -this.amplitude;
		} else {
			t = -t;
			if (t >= this.period) t = t % this.period;
			if (t * 2 < this.period) rv = -this.amplitude;
			else rv = this.amplitude;
		}
		rv += this.shift;
		return rv;
	}

	private sinus(t: number): number {
		let rv: number;
		t += this.phase;
		rv = this.amplitude * Math.sin(t * this.freq0);
		rv += this.shift;
		return rv;
	}

	private random(t: number /* not used */): number {
		let rv: number = this.shift + this.amplitude * Math.random();
		return rv;
	}

	/**
@TODO every time this node is evaluated it should return a new
value, it's not like interval that sleeps in between "changes"
this node will produce a change event on every evaluation loop.
*/

	start() {
		// if (this.interval) {
		// 	clearInterval(this.interval);
		// }

		switch (this.waveform) {
			case 'sinus': {
				this.sinus(this.elapsed());
			}
			case 'square': {
				this.square(this.elapsed());
			}
			case 'sawtooth': {
				this.sawtooth(this.elapsed());
			}
			case 'triangle': {
				this.triangle(this.elapsed());
			}
			case 'random': {
				this.random(this.elapsed());
			}
			default: {
			}
		}

		this.value = Math.random(); //Math.round(performance.now());

		// this.interval = setInterval(() => {
		// 	this.value = Math.round(performance.now());
		// }, this.getIntervalTime(this.options.interval));
	}

	stop() {
		// if (this.interval) {
		// 	clearInterval(this.interval);
		// }
	}
}
