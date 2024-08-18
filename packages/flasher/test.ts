import path from 'path';
import { Flasher } from './src/Flasher';

try {
	const __dirname = path.resolve(path.dirname(''));
	const filePath = path.resolve(
		__dirname,
		'../../apps/electron-app/hex/uno/StandardFirmata.cpp.hex',
	);
	new Flasher('nano', '/dev/tty.usbserial-1140').flash(filePath);
} catch (error) {
	console.log(error);
}
