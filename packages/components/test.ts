import JohnnyFive from 'johnny-five';
import * as Components from './index';

const board = new JohnnyFive.Board({
	repl: true,
});

board.on('ready', () => {
	console.log('board ready');
});
