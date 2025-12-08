import JohnnyFive from 'johnny-five';

import { Pixel } from './src/pixel/pixel';

import { dataSchema } from './src/pixel/pixel.types';

const data = dataSchema.safeParse({
	validator: 'boolean',
});
console.log(data);
const board = new JohnnyFive.Board({
	repl: true,
});

function getBoard() {
	return board;
}

board.on('ready', () => {
	console.log('[BOARD] <ready>');
	makeStrip();
});

function makeStrip() {
	const strip = new Pixel({
		...dataSchema.parse({ pin: 11, length: 12 }),
		board,
	});

	strip.on('ready', function () {
		console.log('[STRIP] <ready>');

		strip.color(['#4f39f6', '#e60076', '#f54a00']);
		setInterval(() => {
			strip.move(1);
			// const randomHex = `#${Math.floor(Math.random() * 16777215).toString(16)}`;
			// strip.color(randomHex);
		}, 1000);

		setTimeout(() => {
			strip.destroy();
			setTimeout(() => {
				makeStrip();
			}, 1000);
		}, 10000);
	});
}
