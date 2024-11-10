import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type MqttDirection = 'publish' | 'subscribe';

export type MqttData = { direction: MqttDirection; topic?: string };
export type MqttValueType = string;

type MqttOptions = BaseComponentOptions & MqttData;

export class Mqtt extends BaseComponent<MqttValueType> {
	constructor(options: MqttOptions) {
		super(options);
	}

	setExternal(value: string) {
		this.value = value;
		this.eventEmitter.emit('subscribe', this.value, false);
	}

	publish(message: string) {
		this.value = message;
	}
}
