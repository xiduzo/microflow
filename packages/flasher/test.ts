import path from 'path';
import { Flasher } from './src/Flasher';

async function flash() {
  try {
    const __dirname = path.resolve(path.dirname(''));
	const filePath = path.resolve(
		__dirname,
		'../../apps/electron-app/hex/leonardo/StandardFirmata.cpp.hex',
	);
    await new Flasher('leonardo', '/dev/tty.usbmodem1101').flash(filePath)
    console.log('done')
  } catch (error) {
    console.log(error);
  }

}

flash()
