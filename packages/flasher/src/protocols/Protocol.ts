import { readFileSync } from 'fs';
import intelhex from 'intel-hex';
import { SerialConnection } from '../SerialConnection';
import { Board } from '../constants';

export abstract class Flasher {
	abstract flash(filePath: string): Promise<void>;
}

export class Protocol {
	constructor(
		protected readonly connection: SerialConnection,
		protected readonly board: Board,
	) {}

	getFileContents(filePath: string) {
		return readFileSync(filePath, { encoding: 'utf8' });
	}

	parseHex(file: string): Buffer {
		return intelhex.parse(Buffer.from(file)).data;
	}
}
