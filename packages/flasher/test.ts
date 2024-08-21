import path from 'path';
import { Flasher } from './src/Flasher';

async function flash() {
	const board = 'mega';
	try {
		const __dirname = path.resolve(path.dirname(''));
		const filePath = path.resolve(
			__dirname,
			`../../apps/electron-app/hex/${board}/StandardFirmata.cpp.hex`,
		);
		await new Flasher(board, '/dev/tty.usbmodem1101').flash(filePath);
		console.log('done');
	} catch (error) {
		console.log(error);
	}
}

flash();
