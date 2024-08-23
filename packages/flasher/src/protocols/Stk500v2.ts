import STK500v2 from 'stk500-v2';
import { Board } from '../constants';
import { SerialConnection } from '../SerialConnection';
import { Flasher, Protocol } from './Protocol';

export class Stk500v2 extends Protocol implements Flasher {
	constructor(connection: SerialConnection, board: Board) {
		super(connection, board);
	}

	async flash(filePath: string) {
		const hasPageSize = 'pageSize' in this.board;

		if (!hasPageSize) {
			throw new Error(
				`pageSize is not defined in board ${this.board.name} but is required for stk500v2 protocol`,
			);
		}

		const file = this.getFileContents(filePath);
		const hex = this.parseHex(file);

		await this.connection.open();
		const stk500v2 = new STK500v2(this.connection.serialPort);

		await this.reset();

		await this.sync(stk500v2, 5);
		await this.verifySignature(stk500v2, this.board.signature);
		await this.enterProgrammingMode(stk500v2, this.board);
		await this.upload(stk500v2, hex, this.board.pageSize);
		await this.exitProgrammingMode(stk500v2);
	}

	private async reset() {
		await this.connection.sendResetSignals(false, 250);
	}

	private async sync(stk500v2: any, retries: number) {
		return new Promise<void>((resolve, reject) => {
			stk500v2.sync(retries, (error: unknown) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}

	private async verifySignature(stk500v2: any, signature: Buffer) {
		return new Promise<void>((resolve, reject) => {
			stk500v2.verifySignature(signature, (error: unknown) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}

	private async enterProgrammingMode(stk500v2: any, board: Board) {
		return new Promise<void>((resolve, reject) => {
			stk500v2.enterProgrammingMode(board, (error: unknown) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}

	private async upload(stk500v2: any, hex: any, pageSize: number) {
		return new Promise<void>((resolve, reject) => {
			stk500v2.upload(hex, pageSize, (error: unknown) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}

	private async exitProgrammingMode(stk500v2: any) {
		return new Promise<void>((resolve, reject) => {
			stk500v2.exitProgrammingMode((error: unknown) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
}
