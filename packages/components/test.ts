import JohnnyFive from 'johnny-five';
import * as Components from './index';

const board = new JohnnyFive.Board({
	repl: true,
});

board.on('ready', () => {
	console.log('board ready');

	setTimeout(() => {
		console.log('Closing board connection...');
		// Access the serial port and close it
		board.io.transport.close(() => {
			console.log('Connection closed');

			const board2 = new JohnnyFive.Board({
				repl: true,
			});

			board2.on('ready', () => {
				console.log('board2 ready');
			});
		});
	}, 5000);
});
