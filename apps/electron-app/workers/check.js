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
	console.info(JSON.stringify(data));
}

try {
	const ipRegex = new RegExp(
		/^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/,
	);
	const portIsIp = ipRegex.test(port);
	let connection;

	if (portIsIp) {
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

	// When board is connected and Firmata is flashed
	board.on('ready', () => stdout({ type: 'ready' }));

	// When board is found but no Firmata is flashed
	board.on('error', error => stdout({ type: 'error', message: error.message }));

	board.on('exit', () => stdout({ type: 'exit' }));
	board.on('close', () => stdout({ type: 'close' }));
	board.on('connect', () => stdout({ type: 'connect' }));

	board.on('info', stdout);
	board.on('fail', stdout);
	board.on('warn', stdout);
} catch (error) {
	stdout({ type: 'error', ...error });
}
