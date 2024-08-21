import STK500 from 'stk500';
import { Board } from '../constants';
import { SerialConnection } from '../SerialConnection';
import { Flasher, Protocol } from './Protocol';

export class Stk500v1 extends Protocol implements Flasher {
	constructor(connection: SerialConnection, board: Board) {
		super(connection, board);
	}

	async flash(filePath: string) {
		const file = this.getFileContents(filePath);
		const hex = this.parseHex(file);

		await this.connection.open();
		await this.reset();
		await this.bootload(hex);
	}

	private async reset() {
		await this.connection.sendResetSignals(false, 250);
		await this.connection.sendResetSignals(true, 50);
	}

	private bootload(hex: Buffer) {
		return new Promise<void>((resolve, reject) => {
			new STK500({ debug: true }).bootload(
				this.connection.serialPort,
				hex,
				this.board,
				(error: unknown) => {
					if (error) {
						reject(error);
						return;
					}

					resolve();
				},
			);
		});
	}
}
