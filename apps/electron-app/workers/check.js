const { Board, TcpSerial } = require('@microflow/components');

const port = process?.argv?.at(-1);

if (!port) {
	console.info(
		JSON.stringify({
			type: 'info',
			message:
				'No port provided, johnny five usualy can handle this. This might cause unforseen behavior.',
		}),
	);
}

function stdout(data) {
	process.send(data);
}

try {
	const ipRegex = new RegExp(
		/^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/,
	);
	let connection;

	if (ipRegex.test(port)) {
		connection = new TcpSerial({ host: port, port: 3030 });

		connection.on('close', () =>
			stdout({
				type: 'close',
				message: `Connection not reachable on ${port}`,
				class: TcpSerial.name,
			}),
		);
	}

	const board = new Board({
		repl: false,
		debug: true,
		port: connection || port,
	});

	// This event will emit after the connect event and only when the Board instance object has completed
	// any hardware initialization that must take place before the program can operate.
	// This process is asynchronous, and completion is signified to the program via a "ready" event
	// For on-board execution, ready should emit after connect.
	board.on('ready', () => stdout({ type: 'ready' }));
	// When board is found but no Firmata is flashed
	board.on('error', error => stdout({ type: 'error', message: error.message }));
	// This event is emitted synchronously on SIGINT.
	// Use this handler to do any necessary cleanup before your program is "disconnected" from the board.
	board.on('exit', () => stdout({ type: 'exit' }));
	// This event is emmited when the device does not respond.
	// Can be used to detect if board gets disconnected.
	board.on('close', () => stdout({ type: 'close' }));
	// This event will emit once the program has "connected" to the board.
	// This may be immediate, or after some amount of time, but is always asynchronous.
	// For on-board execution, connect should emit as soon as possible, but asynchronously.
	board.on('connect', () => stdout({ type: 'connect' }));
	// This event will emit for any logging message: info, warn or fail.
	board.on('message', stdout);
} catch (error) {
	stdout({ type: 'error', message: 'catching error', ...error });
}
