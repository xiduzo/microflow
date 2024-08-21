import { Board, BoardName, BOARDS } from './constants';
import { SerialConnection } from './SerialConnection';

export class Flasher {
	private readonly connection: SerialConnection;
	private readonly board: Board;

	constructor(boardName: BoardName, usbPortPath: string) {
		const board = BOARDS.find(board => board.name === boardName);

		if (!board) {
			throw new Error(`Board ${boardName} is not a know board`);
		}

		this.board = board;
		this.connection = new SerialConnection(board.baudRate, usbPortPath);

		console.debug(`Created flasher for ${board.name} on ${usbPortPath}`);
	}

	async flash(filePath: string) {
		try {
			const protocol = new this.board.protocol(this.connection, this.board);

			console.debug(`Flashing ${filePath}`);
			await protocol.flash(filePath);
			console.debug(`Flashing succeeded!`);
		} catch (error) {
			console.error('Flashing failed', { error });
			throw new Error(
				`Unable to flash ${this.board.name} on ${this.connection.serialPort.path} using ${filePath}`,
			);
		} finally {
			await this.connection.close(); // Always close the port again
		}
	}
}
