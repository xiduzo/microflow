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
	console.log('board ready', board);
	// Test WS2812b using Firmata
	const strip = new Pixel({
		...dataSchema.parse({ data: 11, length: 24 }),
		board,
	});

	strip.on('ready', function () {
		console.log('Strip ready!');

		strip.color(['#ff0000', '#00ff00', '#0000ff']);
		setInterval(() => {
			strip.forward();
			// const randomHex = `#${Math.floor(Math.random() * 16777215).toString(16)}`;
			// strip.color(randomHex);
		}, 1000);
	});
});

// "node": {
// [APP]     "data": {
// [APP]       "instance": "Pixel",
// [APP]       "data": 11,
// [APP]       "length": 78,
// [APP]       "controller": "FIRMATA",
// [APP]       "skip_firmware_check": true,
// [APP]       "gamma": 2.8,
// [APP]       "color_order": "BRG",
// [APP]       "group": "hardware",
// [APP]       "tags": [
// [APP]         "output",
// [APP]         "analog"
// [APP]       ],
// [APP]       "label": "Pixel",
// [APP]       "icon": "ZapIcon",
// [APP]       "description": "Control a strip of addressable RGB LEDs (WS2812, NeoPixel, etc.)"
// [APP]     },
// [APP]     "id": "dyapwbxeqoqu",
// [APP]     "type": "Pixel",
// [APP]     "position": {
// [APP]       "x": 478.7824610575624,
// [APP]       "y": -298.32578777932804
// [APP]     },
// [APP]     "measured": {
// [APP]       "width": 320,
// [APP]       "height": 424
// [APP]     },
// [APP]     "selected": false,
// [APP]     "dragging": false
// [APP]   }
