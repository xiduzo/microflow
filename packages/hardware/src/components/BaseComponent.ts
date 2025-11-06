import EventEmitter from 'events';
import JohnnyFive from 'johnny-five';
import { postMessageToElectronMain } from '../utils/postMessageToElectronMain';

export type BaseComponentData = {
	id: string;
	type: string;
};

type JohnnyFiveComponent =
	| JohnnyFive.Button
	| JohnnyFive.Led
	| JohnnyFive.Led.Matrix
	| JohnnyFive.Led.RGB
	| JohnnyFive.Motion
	| JohnnyFive.Piezo
	| JohnnyFive.Proximity
	| JohnnyFive.Relay
	| JohnnyFive.Sensor
	| JohnnyFive.Servo
	| JohnnyFive.Switch;

export class BaseComponent<
	Value,
	Data,
	Component extends JohnnyFiveComponent | null = null,
> extends EventEmitter {
	private _value: Value;
	private _data: BaseComponentData & Data;

	protected component?: Component;

	public readonly id: string;

	constructor(data: BaseComponentData & Data, initialValue: Value) {
		super();
		this._value = initialValue;
		this._data = data;
		this.id = data.id;

		// Make sure we post the message when the value changes even though no one is listening to the event
		super.on('change', () => this.postMessage('change', this.id));
	}

	set data(data: BaseComponentData & Data) {
		if (JSON.stringify(this._data) === JSON.stringify(data)) return;
		if ('pin' in data && 'pin' in this._data && data.pin !== this._data.pin) {
			throw new PinError(`Can not change pin from ${this._data.pin} to ${data.pin}`);
		}

		if (
			'pins' in data &&
			'pins' in this._data &&
			JSON.stringify(data.pins) !== JSON.stringify(this._data.pins)
		) {
			throw new PinError(
				`Can not change pins from ${JSON.stringify(this._data.pins)} to ${JSON.stringify(data.pins)}`
			);
		}

		this._data = data;
		this.emit('new-data', data);
	}

	get data() {
		return this._data;
	}

	get value() {
		return this._value;
	}

	set value(value: Value) {
		if (JSON.stringify(this._value) === JSON.stringify(value)) return;
		this._value = value;
		this.emit('change', value);
	}

	postMessage(action: string | symbol, target: string) {
		postMessageToElectronMain({
			action,
			source: this.id,
			target,
			value: this.value,
		});
	}

	destroy() {
		if (this.component instanceof EventEmitter) {
			this.component.removeAllListeners(); // Remove all Firmata listeners
		}

		super.removeAllListeners();
	}
}

class PinError extends Error {
	constructor(message: string) {
		super(message);
		this.name = this.constructor.name;
	}
}
