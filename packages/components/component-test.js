const JohnnyFive = require('johnny-five');

const board = new JohnnyFive.Board({
	repl: true,
});

board.on('ready', () => {
	var display = new JohnnyFive.Led.Matrix({
		pins: {
			data: 2,
			clock: 3,
			cs: 4,
		},
		devices: 1,
	});

	display.on(0);
	display.brightness(100);

	display.led(0, 0, '1');
	display.led(1, 1, '1');
	display.led(2, 2, '1');
	display.led(3, 3, '1');
	display.led(4, 4, '1');
	display.led(5, 5, '1');
	display.led(6, 6, '1');
	display.led(7, 7, '1');
});
