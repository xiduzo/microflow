import { BaseComponent, BaseComponentData } from './BaseComponent';

export type MqttDirection = 'publish' | 'subscribe';

export type MqttData = { direction: MqttDirection; topic?: string };
export type MqttValueType = string;

export class Mqtt extends BaseComponent<MqttValueType> {
	constructor(data: BaseComponentData & MqttData) {
		super(data, '');
	}

	setExternal(value: string) {
		this.value = value;
		this.eventEmitter.emit('subscribe', this.value);
	}

	publish(message: string) {
		this.value = message;
	}
}
