import { Code, BaseComponentData } from './BaseComponent';

export type MqttDirection = 'publish' | 'subscribe';

export type MqttData = { direction: MqttDirection; topic?: string };
export type MqttValueType = string;

export class Mqtt extends Code<MqttValueType, MqttData> {
	constructor(data: BaseComponentData & MqttData) {
		super(data, '');
	}

	setExternal(value: string) {
		this.value = value;
		this.emit('subscribe', this.value);
	}

	publish(message: string) {
		this.value = message;
	}
}
