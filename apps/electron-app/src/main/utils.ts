/**
 * Timer utility class for measuring elapsed time
 */
export class Timer {
	constructor(private readonly startTime = performance.now()) {}

	get duration() {
		return performance.now() - this.startTime + 'ms';
	}
}
