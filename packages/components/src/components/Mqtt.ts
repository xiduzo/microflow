import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type MqttOptions = BaseComponentOptions<string>;

export class Mqtt extends BaseComponent<string> {
	constructor(private readonly options: MqttOptions) {
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
