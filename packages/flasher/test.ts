import path from 'path';
import { UnableToOpenSerialConnection } from './src/errors';
import { Flasher } from './src/Flasher';
import { getConnectedPorts } from './src/serialport';

async function flash() {
	const ports = await getConnectedPorts();
	console.log(ports);
	const board = 'mega';
	try {
		const __dirname = path.resolve(path.dirname(''));
		const filePath = path.resolve(
			__dirname,
			`../../apps/electron-app/hex/${board}/StandardFirmata.cpp.hex`,
		);
		await new Flasher(board, '/dev/tty.usbmodem1401').flash(filePath);
		console.log('done');
	} catch (error) {
		if (error instanceof UnableToOpenSerialConnection) {
			console.log('Unable to open serial connection');
			return;
		}
		console.log(error);
	}
}

flash();
