import EventEmitter from 'events';
import { postMessageToElectronMain } from '../utils/postMessageToElectronMain';

export type BaseComponentData = {
	id: string;
};

export class BaseComponent<T> {
	private _value: T;
	private readonly _id: string;

	protected readonly eventEmitter = new EventEmitter();

	constructor(data: BaseComponentData, initialValue: T) {
		this._value = initialValue;
		this._id = data.id;

		this.eventEmitter.on('change', this.postMessage.bind(this, 'change'));
	}

	get value() {
		return this._value;
	}

	set value(value: T) {
		const previousValue = this._value;
		this._value = value;

		if (JSON.stringify(previousValue) !== JSON.stringify(value)) {
			this.eventEmitter.emit('change', value);
		}
	}

	/**
	 * Listen to an event
	 *
	 * @param action - The event to listen to
	 * @param callback - The callback to run when the event is triggered
	 *
	 * @param args Passing a second argument to `args` when emitting the event will determine if the change event should be emitted.
	 *
	 * @example
	 *
	 * // Emitting the change event
	 * this.eventEmitter.emit('change', this.value);
	 * this.eventEmitter.emit('change', this.value, true);
	 *
	 * // Not emitting the change event
	 * this.eventEmitter.emit('change', this.value, false);
	 */
	on(action: string, callback: (...args: any[]) => void) {
		this.eventEmitter.on(action, args => {
			callback(args);
			this.postMessage(action, args[1] === undefined || !!args[1]);
		});
	}

	protected postMessage(action: string, emitChange = true) {
		if (action !== 'change' && emitChange) {
			this.eventEmitter.emit('change', this._value);
		}

		postMessageToElectronMain({
			action,
			nodeId: this._id,
			value: this.value,
		});
	}

	protected postErrorMessage(action: string, error: Error) {
		postMessageToElectronMain({
			action: action,
			nodeId: this._id,
			value: error,
		});
	}
}
