// from https://github.com/mwittig/etherport-client/blob/master/index.js
import { EventEmitter } from 'events';
import { Socket } from 'net';

type Options = {
	port: number;
	host: string;
};

const PING_INTERVAL_MS = 1000;

export class TcpSerial extends EventEmitter {
	private socket: Socket;
	private disconnectTimeout: NodeJS.Timeout | undefined = undefined;
	private pingInterval: NodeJS.Timeout | undefined = undefined;

	name = 'TcpSerial';

	constructor(private readonly options: Options) {
		super();

		this.socket = new Socket();

		this.socket.on('close', this.onCloseHandler.bind(this));
		this.socket.on('connect', this.onConnectHandler.bind(this));
		this.socket.on('data', this.onDataHandler.bind(this));
		this.socket.on('end', this.onEndHandler.bind(this));
		this.socket.on('error', this.onErrorHandler.bind(this));
		this.socket.on('ready', this.onReadyHandler.bind(this));
		this.socket.on('timeout', this.onTimeoutHandler.bind(this));

		this.connect();
	}

	write(buffer: Buffer, callback?: any) {
		if (!Buffer.isBuffer(buffer)) {
			buffer = Buffer.from(buffer);
		}

		if (!this.socket.writable) {
			console.warn('[WRITE] Socket not writable');
			return;
		}

		this.socket.write(buffer, error => {
			if (!error) return;
			console.error('[WRITE] error during writing', error);
			this.socket.destroy(error);
		});

		if (typeof callback !== 'function') return;

		process.nextTick(callback);
	}

	private connect() {
		clearInterval(this.pingInterval);

		this.socket.setNoDelay(true);
		this.socket.setTimeout(5000);
		this.socket.connect(this.options.port, this.options.host, () => {
			console.info('[CONNECTED]');
			this.socket.setTimeout(0);
		});

		this.pingInterval = setInterval(() => {
			// https://github.com/firmata/protocol/blob/master/protocol.md#query-firmware-name-and-version
			this.write(Buffer.from([0xf0, 0x79, 0xf7]));
		}, PING_INTERVAL_MS);
	}

	private timeout() {
		clearTimeout(this.disconnectTimeout);

		this.disconnectTimeout = setTimeout(() => {
			this.socket.destroy();
		}, PING_INTERVAL_MS * 1.25);
	}

	private onCloseHandler(hadError: boolean) {
		console.debug('onCloseHandler', hadError);
		this.socket.destroy();
		this.emit('close', hadError);
	}

	private onConnectHandler() {
		console.debug('onConnectHandler');
		this.socket.setTimeout(0);
		this.emit('connect');
	}

	private onDataHandler(event: Buffer) {
		console.debug('onDataHandler', event.toString());
		this.timeout(); // Start timeout after we have received the first data
		this.emit('data', event);
	}

	private onErrorHandler(error: Error) {
		console.debug('onErrorHandler', error);
		this.socket.destroy();
		this.emit('error', error);
	}

	private onTimeoutHandler() {
		console.debug('onTimeoutHandler');
		this.socket.destroy();
		this.emit('timeout');
	}

	private onEndHandler() {
		console.debug('onEndHandler');
		this.socket.destroy();
		this.emit('end');
	}

	private onReadyHandler() {
		console.debug('onReadyHandler');
		this.emit('ready');
	}
}
