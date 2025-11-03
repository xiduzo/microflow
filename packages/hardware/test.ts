import JohnnyFive from 'johnny-five';
import * as Components from './index';

const board = new JohnnyFive.Board({
	repl: true,
});

board.on('ready', () => {
	const test = new JohnnyFive.Button({
		pin: 2,
	});
	console.log(test, 'remove' in test);
});
