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
	UploadCodeResult,
	UploadedCodeMessage,
} from '../common/types';

let childProcess: UtilityProcess | null = null;

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

	let connectedPort: Port | null = null;

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
				connectedPort = port;
				event.reply('ipc-check-board', result);
				break checkBoard;
			}

			if (result.type === 'error') {
				// Board is connected but no firmata is found,
				// lets try to flash it
				try {
					await flashBoard(board, port);
					connectedPort = port;
					event.reply('ipc-check-board', {
						...result,
						port: port.path,
						type: 'ready',
					} satisfies BoardCheckResult);
					break checkBoard; // board is flashed with firmata, no need to check other ports
				} catch {
					// Ignore error
				}
			}
		}
	}

	// Start sniffing ports for changes in connections
	sniffPorts(event, { connectedPort });
});

ipcMain.on('ipc-upload-code', (event, code: string, portPath: string) => {
	log.info(`Uploading code to port ${portPath}`);

	if (!portPath) {
		log.warn('No port path provided for uploading code');
		return;
	}
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

async function flashBoard(board: KnownBoard, port: Port): Promise<void> {
	childProcess?.kill();
	log.debug(`Try flashing firmata to ${board} on ${port.path}`);

	const avrgirlDir = dirname(require.resolve('avrgirl-arduino'));
	const firmataDir = resolve(avrgirlDir, 'junk', 'hex', board);
	let firmataPath: string | undefined;

	return new Promise((resolve, reject) => {
		readdir(firmataDir, function (readdirError, files) {
			if (readdirError) {
				log.warn(`Could not read firmata directory: ${firmataDir}`, {
					readdirError,
				});
				reject();
				return;
			}

			for (const file of files) {
				if (file.indexOf('StandardFirmata') < 0) continue;

				firmataPath = join(firmataDir, file);
				break;
			}

			if (typeof firmataPath === 'undefined') {
				log.warn(`Could not find Firmata file for ${board}`);
				reject();
				return;
			}

			const avrgirl = new Avrgirl({ board });

			avrgirl.flash(firmataPath, (flashError?: unknown) => {
				if (flashError) {
					log.warn(
						`Unable to flash ${board} on ${port.path} using ${firmataPath}`,
						{ flashError },
					);
					reject();
					return;
				}

				log.debug(`Firmata flashed successfully to ${board} on ${port.path}!`);
				resolve();
			});
		});
	});
}

let portSniffer: NodeJS.Timeout | null = null;
const PORT_SNIFFER_INTERVAL_IN_MS = 250;

function sniffPorts(
	event: IpcMainEvent,
	options: {
		connectedPort?: Port;
		portsConnected?: Port[];
	} = {},
) {
	portSniffer && clearTimeout(portSniffer);

	getConnectedPorts()
		.then(ports => {
			// Check if the connected port is still connected
			if (
				options.connectedPort &&
				!ports.find(port => port.path === options.connectedPort.path)
			) {
				event.reply('ipc-check-board', {
					type: 'exit',
				} satisfies BoardCheckResult);
				return;
			}

			// Check if new ports are connected
			// We only care about this if we don't have a connected port
			if (
				!options.connectedPort &&
				ports.length !== options.portsConnected?.length
			) {
				event.reply('ipc-check-board', {
					type: 'exit',
				} satisfies BoardCheckResult);
				return;
			}

			options.portsConnected = ports;

			portSniffer = setTimeout(() => {
				sniffPorts(event, options);
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

async function getKnownBoardsWithPorts() {
	try {
		const ports = await getConnectedPorts();

		const boardsWithPorts = KNOWN_BOARD_PRODUCT_IDS.reduce(
			(acc, [board, productIds]) => {
				const matchingPorts = ports.filter(port => {
					if (!port._standardPid) return false;
					return productIds.includes('0x' + port._standardPid);
				});

				if (matchingPorts.length) {
					acc.push([board, matchingPorts]);
				}

				return acc;
			},
			[] as [KnownBoard, Port[]][],
		);

		if (boardsWithPorts.length) {
			log.debug('Found boards on ports:');
			boardsWithPorts.forEach(([board, ports]) => {
				log.debug(`  - ${board} on ${ports.map(port => port.path).join(', ')}`);
			});
		}

		return boardsWithPorts;
	} catch (error) {
		log.warn('Could not get known boards with ports', { error });
		return [];
	}
}
