const { Board } = require('@microflow/components');

const port = process.argv.at(-1);

if (!port) {
	process.parentPort.postMessage({
		type: 'info',
		message:
			'No port provided, johnny five usualy can handle this. This might cause unforseen behavior.',
	});
}

let board;

try {
	board = new Board({
		repl: false,
		debug: true,
		port,
	});

	process.parentPort.postMessage({
		type: 'info',
		message: 'checking micro-controller',
	});

	board.on('info', event => {
		process.parentPort.postMessage({
			type: 'info',
			message: event.message,
			class: event.class,
		});
	});

	board.on('ready', () => {
		// When board is connected and Firmata is flashed
		process.parentPort.postMessage({
			type: 'ready',
			pins:
				Object.entries(board.pins)?.reduce((acc, [key, value]) => {
					acc.push({
						pin: Number(key),
						...value,
					});
					return acc;
				}, []) ?? [],
		});
	});

	board.on('error', error => {
		// When board is found but no Firmata is flashed
		process.parentPort.postMessage({
			type: 'error',
			message: error.message,
		});
	});

	board.on('fail', event => {
		// When board is not found
		process.parentPort.postMessage({
			type: 'fail',
			message: event.message,
			class: event.class,
		});
	});

	board.on('warn', event => {
		// TODO: find out when this fires
		process.parentPort.postMessage({
			type: 'warn',
			message: event.message,
			class: event.class,
		});
	});

	board.on('exit', () => {
		// TODO: find out when this fires
		process.parentPort.postMessage({
			type: 'exit',
		});
	});

	board.on('close', () => {
		// TODO: find out when this fires
		process.parentPort.postMessage({
			type: 'close',
		});
	});
} catch (error) {
	process.parentPort.postMessage({
		type: 'error',
		message: error.message,
	});
}
