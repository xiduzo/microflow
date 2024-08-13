import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type MqttOptions = BaseComponentOptions<string>;

export class Mqtt extends BaseComponent<string> {
	constructor(private readonly options: MqttOptions) {
		super(options);

		this.eventEmitter.on('change', this.postMessage.bind(this, 'change'));
		this.eventEmitter.on('subscribe', this.postMessage.bind(this, 'subscribe'));
	}

	setExternal(value: string) {
		this.value = value;
		this.eventEmitter.emit('subscribe');
	}

	publish(message: string) {
		this.value = message;
	}
}
