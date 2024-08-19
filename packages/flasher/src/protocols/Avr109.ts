import { SerialPort } from 'serialport';
import { Board } from '../constants';
import { SerialConnection } from '../SerialConnection';
import { Flasher, Protocol } from './Protocol';

import AVR109 from 'chip.avr.avr109';

export class Avr109 extends Protocol implements Flasher {
	constructor(connection: SerialConnection, board: Board) {
		super(connection, board);
	}

	async flash(filePath: string) {
		const file = this.getFileContents(filePath);

		await this.reset();
		let port;
		let tries = 15;
		do {
			const ports = await SerialPort.list();
			port = ports.find(port => port.path === this.connection.serialPort.path);
			await new Promise(resolve => setTimeout(resolve, 100));
		} while (!port && --tries);

		if (!port) {
			throw new Error(
				`Serial port ${this.connection.serialPort.path} not found`,
			);
		}

		await this.connection.open();
		await this.bootload(file);
	}

	private async reset() {
		const path = this.connection.serialPort.path;
		const resetSerialConnection = new SerialConnection(1200, path);
		await resetSerialConnection.open();
		await resetSerialConnection.sendResetSignals(false, 250);
		await resetSerialConnection.close();
	}

	private async bootload(file: string) {
		return new Promise<void>((resolve, reject) => {
			const signature = this.board.signature.toString();

			AVR109.init(
				this.connection.serialPort,
				{ signature, debug: true },
				async (error: unknown, flasher: any) => {
					if (error) {
						reject(error);
						return;
					}

					await this.erase(flasher);
					await this.program(flasher, file);
					await this.verify(flasher);
					await this.fuseCheck(flasher);

					resolve();
				},
			);
		});
	}

	private async erase(flasher: any) {
		return new Promise<void>((resolve, reject) => {
			flasher.erase((error: unknown) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}

	private async program(flasher: any, file: string) {
		return new Promise<void>((resolve, reject) => {
			flasher.program(file, (error: unknown) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}

	private async verify(flasher: any) {
		return new Promise<void>((resolve, reject) => {
			flasher.verify((error: unknown) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}

	private async fuseCheck(flasher: any) {
		return new Promise<void>((resolve, reject) => {
			flasher.fuseCheck((error: unknown) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
}
