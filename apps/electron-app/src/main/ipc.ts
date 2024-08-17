import Avrgirl, { type KnownBoard, type Port } from 'avrgirl-arduino';

import {
	ipcMain,
	IpcMainEvent,
	Menu,
	utilityProcess,
	UtilityProcess,
} from 'electron';
import log from 'electron-log/node';
import { readdir, writeFile } from 'fs';
import { dirname, join, resolve } from 'path';
import {
	BoardCheckResult,
	BoardFlashResult,
	UploadCodeResult,
	UploadedCodeMessage,
} from '../common/types';

let childProcess: UtilityProcess | null = null;
let portSniffer: NodeJS.Timeout | null = null;
const PORT_SNIFFER_INTERVAL_IN_MS = 250;

// https://github.com/noopkat/avrgirl-arduino/blob/master/boards.js
const KNOWN_BOARD_PRODUCT_IDS: [KnownBoard, string[]][] = [
	['uno', ['0x0043', '0x7523', '0x0001', '0xea60', '0x6015']],
	['mega', ['0x0042', '0x6001', '0x0010', '0x7523']],
	['leonardo', ['0x0036', '0x8036', '0x800c']],
	['micro', ['0x0037', '0x8037', '0x0036', '0x0237']],
	['nano', ['0x6001', '0x7523']],
	['yun', ['0x0041', '0x8041']],
];

// ipcMain.on("shell:open", () => {
//   const pageDirectory = __dirname.replace('app.asar', 'app.asar.unpacked')
//   const pagePath = path.join('file://', pageDirectory, 'index.html')
//   shell.openExternal(pagePath)
// })
//

ipcMain.on('ipc-menu', (_event, action, ...args) => {
	switch (action) {
		case 'auto-save':
			const checked = Boolean(args[0]);
			Menu.getApplicationMenu().getMenuItemById('autosave').checked = checked;
			break;
	}
});

ipcMain.on('ipc-check-board', async event => {
	childProcess?.kill();

	const boardsAndPorts = await getKnownBoardsWithPorts();

	const filePath = join(__dirname, 'check.js');

	let connectedToPort: Port | null = null;

	// Check board on all ports which match the known product IDs
	checkBoard: for (const [board, ports] of boardsAndPorts) {
		for (const port of ports) {
			log.debug(`checking board ${board} on path ${port.path}`);

			const result = await new Promise<BoardCheckResult>(resolve => {
				childProcess = utilityProcess.fork(filePath, [port.path], {
					serviceName: 'Microflow studio - micro-controller validator',
				});

				childProcess.on('message', async (message: BoardCheckResult) => {
					if (message.type !== 'info') {
						childProcess?.kill(); // Free up the port again
						resolve(message);
						return;
					}

					// Inform info messages to the renderer
					event.reply('ipc-check-board', message);
				});
			});

			if (result.type === 'ready') {
				// board is ready, no need to check other ports
				connectedToPort = port;
				event.reply('ipc-check-board', result);
				break checkBoard;
			}

			if (result.type === 'error') {
				// Board is connected but no firmata is found,
				// send message to the renderer and lets try to flash it
				event.reply('ipc-check-board', {
					...result,
					type: 'info',
					class: 'Connected',
				} satisfies BoardCheckResult);

				try {
					await flashBoard(board, port);
					connectedToPort = port;
					event.reply('ipc-check-board', {
						...result,
						port: port.path,
						type: 'ready',
					} satisfies BoardCheckResult);
					break checkBoard; // board is flashed with firmata, no need to check other ports
				} catch (error) {
					log.warn('Board could not be flashed', { board, error });
				}
			}
		}
	}

	if (!!connectedToPort) {
		sniffPorts(connectedToPort, event); // detect for disconnected board
		return;
	}

	event.reply('ipc-check-board', {
		type: 'error',
		message: 'Unable to auto-connect to a micro-controller',
	} satisfies BoardCheckResult);
});

ipcMain.on(
	'ipc-flash-firmata',
	async (event, board: KnownBoard, path: string) => {
		childProcess?.kill();

		console.log('ipc-flash-firmata', board, path);

		const ports = await getConnectedPorts();
		const port = ports.find(port => port.path === path);

		console.log('ports', port);

		if (!port) {
			event.reply('ipc-flash-firmata', {
				type: 'error',
				message: `No port found on path ${path}`,
			} satisfies BoardFlashResult);
			return;
		}

		event.reply('ipc-flash-firmata', {
			type: 'flashing',
		} satisfies BoardFlashResult);

		try {
			await flashBoard(board, port);
			event.reply('ipc-flash-firmata', {
				type: 'done',
			} satisfies BoardFlashResult);
		} catch (error) {
			log.warn({ error });
			event.reply('ipc-flash-firmata', {
				type: 'error',
				message: error.message,
			} satisfies BoardFlashResult);
		}
	},
);

ipcMain.on('ipc-upload-code', (event, code: string, portPath: string) => {
	log.debug('ipc-upload-code', { portPath });
	childProcess?.kill();

	const filePath = join(__dirname, 'temp.js');
	writeFile(filePath, code, error => {
		if (error) {
			log.error('write file error', { error });
			event.reply('ipc-upload-code', {
				type: 'error',
				message: error.message,
			} satisfies UploadCodeResult);
			return;
		}

		childProcess = utilityProcess.fork(filePath, [portPath], {
			serviceName: 'Microflow studio - micro-controller runner',
		});
		childProcess.on(
			'message',
			(message: UploadedCodeMessage | UploadCodeResult) => {
				if ('type' in message) {
					event.reply('ipc-upload-code', message);
					return;
				}

				event.reply('ipc-microcontroller', message);
			},
		);
	});
});

ipcMain.on('ipc-external-value', (_event, nodeId: string, value: unknown) => {
	childProcess?.postMessage({ nodeId, value });
});

async function getKnownBoardsWithPorts() {
	try {
		const ports = await getConnectedPorts();

		return KNOWN_BOARD_PRODUCT_IDS.reduce(
			(acc, [board, productIds]) => {
				const matchingPorts = ports.filter(port => {
					if (!port._standardPid) return false;
					return productIds.includes('0x' + port._standardPid);
				});

				acc.push([board, matchingPorts]);
				return acc;
			},
			[] as [KnownBoard, Port[]][],
		);
	} catch (error) {
		log.warn({ error });
	}
}

async function flashBoard(board: KnownBoard, port: Port): Promise<void> {
	childProcess?.kill();
	log.debug('Try flashing firmata', { board, port });

	const avrgirlDir = dirname(require.resolve('avrgirl-arduino'));
	const firmataDir = resolve(avrgirlDir, 'junk', 'hex', board);
	let firmataPath: string | undefined;

	return new Promise((resolve, reject) => {
		readdir(firmataDir, function (readdirError, files) {
			if (readdirError) {
				log.warn({ readdirError });
				reject(readdirError);
				return;
			}

			for (const file of files) {
				if (file.indexOf('StandardFirmata') < 0) continue;

				firmataPath = join(firmataDir, file);
				break;
			}

			if (typeof firmataPath === 'undefined') {
				const noFirmataPathError = new Error(
					"oops! Couldn't find Standard Firmata file for " + board + ' board.',
				);
				log.warn(noFirmataPathError.message);
				reject(noFirmataPathError);
				return;
			}

			const avrgirl = new Avrgirl({ board });

			avrgirl.flash(firmataPath, (flashError?: unknown) => {
				const flashErrorResponse = new Error(
					'oops! Unable to flash device. Make sure the correct board is selected and no other program is using the device.',
				);
				if (flashError) {
					log.warn({ flashError });
					reject(flashErrorResponse);
					return;
				}

				log.debug('Firmata flashed successfully', { board });
				resolve();
			});
		});
	});
}

function sniffPorts(connectedPort: Port, event: IpcMainEvent) {
	portSniffer && clearTimeout(portSniffer);

	getConnectedPorts()
		.then(ports => {
			if (!ports.find(port => port.path === connectedPort.path)) {
				event.reply('ipc-check-board', {
					type: 'exit',
				} satisfies BoardCheckResult);
				return;
			}

			portSniffer = setTimeout(() => {
				sniffPorts(connectedPort, event);
			}, PORT_SNIFFER_INTERVAL_IN_MS);
		})
		.catch(log.warn);
}

async function getConnectedPorts(): Promise<Port[]> {
	return new Promise((resolve, reject) => {
		Avrgirl.list((error: unknown, ports: Port[]) => {
			if (error) {
				reject(error);
				return;
			}

			resolve(ports);
		});
	});
}
