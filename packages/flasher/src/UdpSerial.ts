import { EventEmitter } from 'events';
import { Socket } from 'net';

type Options = {
	port: number;
	host: string;
	reconnectTimeoutSecs?: number;
};
export class UdpSerial extends EventEmitter {
	private socket: Socket;
	private reconnectTimer: NodeJS.Timeout | undefined = undefined;
	private queue: Buffer[] = [];

	constructor(private readonly options: Options) {
		super();

		this.socket = new Socket();
		this.socket.on('connect', this.onConnectHandler.bind(this));
		this.socket.on('data', this.onDataHandler.bind(this));
		this.socket.on('error', this.onErrorHandler.bind(this));
		this.socket.on('timeout', this.onTimeoutHandler.bind(this));
		this.socket.on('close', this.onCloseHandler.bind(this));

		this.connect();
	}

	private connect() {
		this.socket.setNoDelay(true);
		this.socket.setTimeout(5000);
		this.socket.connect(this.options.port, this.options.host, () => {
			console.log('connected');
		});
	}

	private reconnect() {
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(
			() => {
				this.connect();
			},
			(this.options.reconnectTimeoutSecs ?? 15) * 1000,
		);
	}

	private onCloseHandler(event: unknown) {
		console.debug('onCloseHandler', event);
		this.reconnect();
	}

	private onConnectHandler(event: unknown) {
		console.debug('onConnectHandler', event);
		this.socket.setTimeout(0);
		this.flushTo();
	}

	private onDataHandler(event: unknown) {
		console.debug('onDataHandler', event);
		this.emit('data', event);
	}

	private onErrorHandler(event: unknown) {
		console.debug('onErrorHandler', event);
		this.emit('error', event);
		this.reconnect();
	}

	private onTimeoutHandler(event: unknown) {
		console.debug('onTimeoutHandler', event);
		this.emit('timeout', event);
		this.socket.destroy();
		this.reconnect();
	}

	private flushTo() {
		this.emit('open');

		this.queue.forEach(buffer => {
			this.socket.write(buffer);
		});

		// Clear queue
		this.queue.length = 0;
	}
}
