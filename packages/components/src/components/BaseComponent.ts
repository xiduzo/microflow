import EventEmitter from 'events';
import { postMessageToElectronMain } from '../utils/postMessageToElectronMain';

export type BaseComponentData = {
	id: string;
};

export class BaseComponent<T> {
	private _value: T;
	private readonly _id: string;

	private readonly eventEmitter = new EventEmitter();

	constructor(data: BaseComponentData, initialValue: T) {
		this._value = initialValue;
		this._id = data.id;

		this.eventEmitter.on('change', () => {
			this.emit('change', this.value);
		});
	}

	get value() {
		return this._value;
	}

	set value(value: T) {
		const previousValue = this._value;
		this._value = value;

		if (JSON.stringify(previousValue) !== JSON.stringify(value)) {
			this.emit('change', value);
		}
	}

	emit(handle: string, value: T | undefined = undefined) {
		this.eventEmitter.emit('event', { handle, value });
	}

	/**
	 * Listen to events
	 *
	 * @param action - The event to listen to
	 * @param callback - The callback to run when the event is triggered
	 *
	 */
	subscribe(callback: (...args: any[]) => void) {
		this.eventEmitter.on('event', args => {
			const { handle } = args;
			callback(args);
			this.postMessage(handle);
		});
	}

	unsubscribe() {
		this.eventEmitter.removeAllListeners();
	}

	private postMessage(handle: string) {
		postMessageToElectronMain({
			action: handle,
			nodeId: this._id,
			value: this.value,
		});
	}
}
