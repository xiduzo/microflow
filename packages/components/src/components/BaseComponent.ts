import EventEmitter from 'events';
import { postMessageToElectronMain } from '../utils/postMessageToElectronMain';

export type BaseComponentOptions<T> = {
	id: string;
	value: T;
};

export class BaseComponent<T> {
	private _value: T;
	private readonly _id: string;

	protected readonly eventEmitter = new EventEmitter();

	constructor(options: BaseComponentOptions<T>) {
		this._value = options.value;
		this._id = options.id;

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

	on(action: string, callback: (...args: any[]) => void) {
		this.eventEmitter.on(action, callback);
	}

	protected postMessage(action: string) {
		if (action !== 'change') {
			this.eventEmitter.emit('change', this._value);
		}

		postMessageToElectronMain({
			action,
			nodeId: this._id,
			value: this.value,
		});
	}
}
