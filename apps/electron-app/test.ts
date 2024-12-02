import { TcpSerial, EtherPortClient } from '@microflow/components';
import { getConnectedPorts } from '@microflow/flasher';
import * as JohnnyFive from 'johnny-five';

const KNOWN_BOARD_PRODUCT_IDS = [
	['uno', ['0043', '7523', '0001', 'ea60', '6015']],
	['mega', ['0042', '6001', '0010', '7523']],
	['leonardo', ['0036', '8036', '800c']],
	['micro', ['0037', '8037', '0036', '0237']],
	['nano', ['6001', '7523']],
	['yun', ['0041', '8041']],
];

async function test() {
	const ports = await getConnectedPorts();
	console.log(ports);
	const connection = new TcpSerial({
		host: '192.168.2.26',
		port: 3030,
	});
	const board = new JohnnyFive.Board({
		port: connection,
		repl: false,
		debug: true,
	});

	// connection.on('connect', e => {
	// 	console.log('connected', e);
	// });
	// connection.on('data', e => {
	// 	console.log('data', (e as Buffer).toString());
	// });
	// connection.on('error', e => {
	// 	console.log('error', e);
	// });
	// connection.on('timeout', e => {
	// 	console.log('timeout', e);
	// });
	connection.on('close', e => {
		console.log('close', e);
	});

	board.on('ready', () => {
		console.log('ready');
		const led = new JohnnyFive.Led({
			pin: 13,
		});

		setInterval(() => {
			led.toggle();
		}, 500);
	});
	board.on('error', event => {
		console.info('board error', { event });
	}); // board - error

	board.on('fail', event => {
		console.info('board fail', { event });
	}); // board - fail

	board.on('warn', event => {
		console.info('board warn', { event });
	}); // board - warn

	board.on('exit', () => {
		console.info('board exit', {});
	}); // board - exit

	board.on('close', () => {
		console.info('board close', {});
	}); // board - close

	board.on('info', event => {
		console.info('board info', { event });
	}); // board - info
}

test();
