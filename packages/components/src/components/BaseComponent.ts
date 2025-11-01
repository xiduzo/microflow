import EventEmitter from 'events';
import { postMessageToElectronMain } from '../utils/postMessageToElectronMain';

export type BaseComponentData = {
	id: string;
	type: string;
};
export class BaseComponent<T, D> {
	private _value: T;
	private readonly _id: string;

	protected readonly eventEmitter = new EventEmitter();

	private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();

	constructor(
		public data: BaseComponentData & D,
		initialValue: T
	) {
		this._value = initialValue;
		this._id = data.id;

		// Make sure we post the message when the value changes even though no one is listening to the event
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
		if (!this.handlers.has(action)) {
			this.handlers.set(action, new Set());
		}

		const handlerWrapper = (...args: any[]) => {
			callback(...args);
			if (action === 'change') return; // We already post the message when the value changes
			this.postMessage(action);
		};

		this.handlers.get(action)!.add(handlerWrapper);
		this.eventEmitter.on(action, handlerWrapper);

		// Return unsubscribe function (nice ergonomic API)
		return () => this.off(action, handlerWrapper);
	}

	off(action: string, callback: (...args: any[]) => void) {
		const handlerSet = this.handlers.get(action);
		if (!handlerSet) return;

		if (handlerSet.has(callback)) {
			handlerSet.delete(callback);
			this.eventEmitter.off(action, callback);
		}

		if (handlerSet.size === 0) {
			this.handlers.delete(action);
		}
	}

	private postMessage(action: string) {
		postMessageToElectronMain({
			action,
			nodeId: this._id,
			value: this.value,
		});
	}
}
