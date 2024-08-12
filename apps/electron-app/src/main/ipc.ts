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

ipcMain.on('ipc-menu', (_event, action, ...args) => {
	switch (action) {
		case 'auto-save':
			const checked = Boolean(args[0]);
			Menu.getApplicationMenu().getMenuItemById('autosave').checked = checked;
			break;
	}
});

ipcMain.on('ipc-check-board', event => {
	childProcess?.kill();

	const filePath = join(__dirname, 'check.js');

	childProcess = utilityProcess.fork(filePath);
	childProcess.on('message', async (message: BoardCheckResult) => {
		if (message.type !== 'info') {
			childProcess?.kill(); // Free up the port again
		}

		if (message.type !== 'error') {
			event.reply('ipc-check-board', message satisfies BoardCheckResult);
		} else {
			try {
				await forceFlashBoard();
				event.reply('ipc-check-board', {
					type: 'ready',
				} satisfies BoardCheckResult); // We know the board can run Firmata now
			} catch (error) {
				log.warn({ error });
				event.reply('ipc-check-board', message satisfies BoardCheckResult);
			}
		}

		message.port && sniffPorts(message.port, event);
	});
});

ipcMain.on('ipc-flash-firmata', async (event, board: KnownBoard) => {
	childProcess?.kill();
	event.reply('ipc-flash-firmata', {
		type: 'flashing',
	} satisfies BoardFlashResult);

	try {
		await flashBoard(board);
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
});

ipcMain.on('ipc-upload-code', (event, code: string) => {
	childProcess?.kill();

	const filePath = join(__dirname, 'temp.js');
	writeFile(filePath, code, error => {
		if (error) {
			log.error({ error });
			event.reply('ipc-upload-code', {
				type: 'error',
				message: error.message,
			} satisfies UploadCodeResult);
			return;
		}

		childProcess = utilityProcess.fork(filePath);
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

ipcMain.on(
	'ipc-external-value',
	(_event, nodeType: string, nodeId: string, value: unknown) => {
		childProcess?.postMessage({ nodeType, nodeId, value });
	},
);

async function forceFlashBoard(): Promise<void> {
	return new Promise(async (resolve, reject) => {
		try {
			const ports = await getConnectedDevices();
			const potentialBoardsToFlash = KNOWN_BOARD_PRODUCT_IDS.filter(
				([, productIds]) => {
					for (const port of ports) {
						if (!port._standardPid) continue;
						if (productIds.includes('0x' + port._standardPid)) {
							return true;
						}
					}

					return false;
				},
			);

			flashing: for (const [board] of potentialBoardsToFlash) {
				try {
					await flashBoard(board);
					resolve();
					break flashing; // We have successfully flashed the board and can stop trying the other boards
				} catch (flashError) {
					log.warn({ flashError });
				}
			}
		} catch (error) {
			log.warn({ error });
		}

		reject(); // Should fire if we didn't flash any board
	});
}

async function flashBoard(board: KnownBoard): Promise<void> {
	log.debug('Try flashing firmata', { board });
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
				log.warn({ noFirmataPathError });
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

function sniffPorts(connectedPort: string, event: IpcMainEvent) {
	portSniffer && clearTimeout(portSniffer);

	getConnectedDevices()
		.then(ports => {
			if (!ports.find(port => port.path === connectedPort)) {
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

async function getConnectedDevices(): Promise<Port[]> {
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
