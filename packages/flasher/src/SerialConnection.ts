import { SerialPort } from 'serialport';

export class SerialConnection {
	serialPort: SerialPort;

	constructor(baudRate: number, path: string) {
		this.serialPort = new SerialPort({
			autoOpen: false,
			path,
			baudRate,
		});
	}

	async sendResetSignals(value: boolean, delay: number) {
		return new Promise<void>((resolve, reject) => {
			this.serialPort.set({ rts: value, dtr: value }, error => {
				if (error) {
					reject(error);
					return;
				}

				setTimeout(() => {
					console.debug(`Reset signal sent`, value, delay);
					resolve();
				}, delay);
			});
		});
	}

	async open() {
		return new Promise<void>((resolve, reject) => {
			this.serialPort.open(error => {
				if (error) {
					reject(error);
					return;
				}

				console.debug(`Serial port opened on ${this.serialPort.path}`);
				resolve();
			});
		});
	}

	async close() {
		return new Promise<void>((resolve, reject) => {
			this.serialPort.close(error => {
				if (error) {
					reject(error);
					return;
				}

				console.debug(`Serial port closed on ${this.serialPort.path}`);
				resolve();
			});
		});
	}
}
