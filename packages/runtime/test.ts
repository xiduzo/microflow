import JohnnyFive from 'johnny-five';

import pixel from 'node-pixel';

import { dataSchema } from './src/compare/compare.types';

const data = dataSchema.safeParse({
	validator: 'boolean',
});
console.log(data);
const board = new JohnnyFive.Board({
	repl: true,
});

board.on('ready', () => {
	// Test WS2812b using Firmata
	const strip = new pixel.Strip({
		data: 12, // LED data pin
		length: 24, // number of LEDs
		// @ts-ignore board errpr
		board: board,
		controller: 'FIRMATA', // Use Firmata-controlled Arduino
		skip_firmware_check: true,
	});

	strip.on('ready', function () {
		console.log('Strip ready!');

		// Set all LEDs to red:
		strip.color('#ff0000');
		strip.show();

		let pos = 0;

		// Simple animation: moving white pixel
		setInterval(function () {
			strip.color('#000000'); // clear strip
			strip.pixel(pos).color('#ffcc00');
			strip.show();

			pos = (pos + 1) % strip.length;
		}, 100);
	});

	strip.on('error', err => {
		console.error('WS2812b error:', err);
	});
});
