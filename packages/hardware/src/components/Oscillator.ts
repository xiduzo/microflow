import { BaseComponent, BaseComponentData } from './BaseComponent';
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
	autoStart?: boolean;
};
export type OscillatorValueType = number;

export class Oscillator extends BaseComponent<OscillatorValueType, OscillatorData> {
	// auto-calculated values when "period" is reset
	private freq1 = 0;
	private freq2 = 0;
	private freq4 = 0;
	private freq0 = 0;

	// internal logic
	private started = 0;
	private lastTime = 0;
	private FRAMES_PER_SECOND = 60;
	private refreshRate = 1_000 / this.FRAMES_PER_SECOND;
	private timeout: NodeJS.Timeout | null = null;

	constructor(data: BaseComponentData & OscillatorData) {
		super(data, 0);

		this.freq1 = 1 / this.data.period;
		this.freq2 = 2 * this.freq1;
		this.freq4 = 4 * this.freq1;
		this.freq0 = 2 * Math.PI * this.freq1;

		if (data.autoStart) this.start();
	}

	reset() {
		this.started = performance.now();
	}

	start() {
		this.stop();
		this.reset();
		this.started = this.ellapsed();
		this.timeout = setTimeout(this.loop.bind(this), this.refreshRate);
	}

	private sawtooth(timestamp: number) {
		let value = 0;
		timestamp += this.data.phase;

		if (timestamp >= 0.0) {
			if (timestamp >= this.data.period) timestamp = timestamp % this.data.period;
			value = this.data.amplitude * (-1.0 + timestamp * this.freq2);
		} else {
			timestamp = -timestamp;
			if (timestamp >= this.data.period) timestamp = timestamp % this.data.period;
			value = this.data.amplitude * (1.0 - timestamp * this.freq2);
		}

		return value + this.data.shift;
	}

	private triangle(timestamp: number) {
		let value = 0;
		timestamp += this.data.phase;

		if (timestamp < 0.0) timestamp = -timestamp;
		if (timestamp >= this.data.period) timestamp = timestamp % this.data.period;
		if (timestamp * 2 < this.data.period) {
			value = this.data.amplitude * (-1.0 + timestamp * this.freq4);
		} else {
			value = this.data.amplitude * (3.0 - timestamp * this.freq4);
		}

		return value + this.data.shift;
	}

	private square(timestamp: number) {
		let value = 0;
		timestamp += this.data.phase;

		if (timestamp >= 0) {
			if (timestamp >= this.data.period) timestamp = timestamp % this.data.period;
			if (timestamp + timestamp < this.data.period) value = this.data.amplitude;
			else value = -this.data.amplitude;
		} else {
			timestamp = -timestamp;
			if (timestamp >= this.data.period) timestamp = timestamp % this.data.period;
			if (timestamp * 2 < this.data.period) value = -this.data.amplitude;
			else value = this.data.amplitude;
		}

		return value + this.data.shift;
	}

	private sinus(timestamp: number) {
		let value: number;
		timestamp += this.data.phase;

		value = this.data.amplitude * Math.sin(timestamp * this.freq0);
		value += this.data.shift;

		return value;
	}

	private random() {
		return (this.data.shift + this.data.amplitude) * Math.random();
	}

	private ellapsed() {
		return performance.now() - this.started;
	}

	private loop() {
		const currentTime = this.ellapsed();

		switch (this.data.waveform) {
			case 'sinus': {
				this.value = this.sinus(currentTime);
				break;
			}
			case 'square': {
				this.value = this.square(currentTime);
				break;
			}
			case 'sawtooth': {
				this.value = this.sawtooth(currentTime);
				break;
			}
			case 'triangle': {
				this.value = this.triangle(currentTime);
				break;
			}
			case 'random': {
				this.value = this.random();
				break;
			}
		}

		// Schedule next update
		const nextUpdateTime = this.lastTime + this.refreshRate;
		const now = performance.now();
		const timeout = Math.max(0, nextUpdateTime - now);

		// console.log(`next update in ${timeout}ms`);
		this.lastTime = nextUpdateTime; // Update last time to the ideal time, not actual time
		this.timeout = setTimeout(this.loop.bind(this), timeout);
	}

	stop() {
		this.timeout && clearTimeout(this.timeout);
	}
}
