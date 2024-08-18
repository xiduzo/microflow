import { Flasher, type BoardName } from '@microflow/flasher';
import {
	ipcMain,
	IpcMainEvent,
	Menu,
	utilityProcess,
	UtilityProcess,
} from 'electron';
import log from 'electron-log/node';
import { existsSync, writeFile } from 'fs';
import { join, resolve } from 'path';
import { SerialPort } from 'serialport';
import {
	BoardCheckResult,
	UploadCodeResult,
	UploadedCodeMessage,
} from '../common/types';

let childProcess: UtilityProcess | null = null;

const isDev = process.env.NODE_ENV === 'development';
const resourcesPath = isDev ? __dirname : process.resourcesPath;

// https://johnny-five.io/platform-support/
const KNOWN_BOARDS = [
	// 'adk',
	// 'arduboy',
	// 'blend-micro',
	// 'bqZum',
	// 'circuit-playground-classic',
	// 'duemilanove168',
	// 'duemilanove328',
	// 'esplora',
	// 'feather',
	// 'imuduino',
	'leonardo',
	// 'lilypad-usb',
	// 'little-bits',
	'mega',
	'micro',
	// 'nano (new bootloader)',
	'nano',
	// 'pinoccio',
	// 'pro-mini',
	// 'qduino',
	// 'sf-pro-micro',
	// 'tinyduino',
	'uno',
	// 'xprov4',
	'yun',
	// 'zumcore2',
	// 'zumjunior',
];

// type KnownBoard = (typeof KNOWN_BOARDS)[number];
const KNOWN_BOARD_PRODUCT_IDS: [BoardName, string[]][] = [
	// ['uno', ['0043', '7523', '0001', 'ea60', '6015']],
	// ['mega', ['0042', '6001', '0010', '7523']],
	// ['leonardo', ['0036', '8036', '800c']],
	// ['micro', ['0037', '8037', '0036', '0237']],
	['nano', ['6001', '7523']],
	// ['yun', ['0041', '8041']],
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

	const filePath = join(resourcesPath, 'workers', 'check.js');
	log.debug('Getting check file', { filePath });

	let connectedPort: PortInfo | null = null;

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
					log.debug('Board flashed', { board, port });
					connectedPort = port;
					event.reply('ipc-check-board', {
						...result,
						port: port.path,
						type: 'ready',
					} satisfies BoardCheckResult);
					break checkBoard; // board is flashed with firmata, no need to check other ports
				} catch (error) {
					log.warn('Error flashing board', { error });
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

	const filePath = join(resourcesPath, 'temp.js');
	log.debug('Writing code to file', { filePath });
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

async function flashBoard(board: BoardName, port: PortInfo): Promise<void> {
	childProcess?.kill();
	log.debug(`Try flashing firmata to ${board} on ${port.path}`);

	const firmataPath = resolve(
		resourcesPath,
		'hex',
		board,
		'StandardFirmata.cpp.hex',
	);

	// Check if file exists
	if (!existsSync(firmataPath)) {
		log.error(`Firmata file not found at ${firmataPath}`);
		return;
	}

	return new Promise(async (resolve, reject) => {
		log.debug(`Flashing firmata from ${firmataPath}`);
		try {
			new Flasher(board, port.path)
				.flash(firmataPath)
				.then(err => {
					console.log(err);
					log.debug(
						`Firmata flashed successfully to ${board} on ${port.path}!`,
					);
					resolve();
				})
				.catch(err => {
					log.debug('flasher', err);
				});
		} catch (flashError) {
			log.error(
				`Unable to flash ${board} on ${port.path} using ${firmataPath}`,
				{ flashError },
			);
			reject();
		}

		// const avrgirl = new Avrgirl({ board });

		// avrgirl.flash(firmataPath, (flashError?: unknown) => {
		// 	if (flashError) {
		// 		log.warn(
		// 			`Unable to flash ${board} on ${port.path} using ${firmataPath}`,
		// 			{ flashError },
		// 		);
		// 		reject();
		// 		return;
		// 	}

		// 	log.debug(`Firmata flashed successfully to ${board} on ${port.path}!`);
		// 	resolve();
		// });
	});
}

let portSniffer: NodeJS.Timeout | null = null;
const PORT_SNIFFER_INTERVAL_IN_MS = 250;

function sniffPorts(
	event: IpcMainEvent,
	options: {
		connectedPort?: PortInfo;
		portsConnected?: PortInfo[];
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

async function getConnectedPorts() {
	return SerialPort.list();
}

type PortInfo = { path: string };
// type PortInfo = Awaited<ReturnType<typeof SerialPort.list>>[number];
async function getKnownBoardsWithPorts() {
	try {
		const ports = await getConnectedPorts();

		const boardsWithPorts = KNOWN_BOARD_PRODUCT_IDS.reduce(
			(acc, [board, productIds]) => {
				const matchingDevices = ports.filter(port => {
					const productId = port.productId || port.pnpId;
					if (!productId) return false;
					return productIds.includes(productId.toLowerCase());
				});

				if (matchingDevices.length) {
					acc.push([board, matchingDevices]);
				}

				return acc;
			},
			[] as [BoardName, PortInfo[]][],
		);

		if (boardsWithPorts.length) {
			log.debug('Found boards on ports:');
			boardsWithPorts.forEach(([board, devices]) => {
				log.debug(
					`  - ${board} on ${devices.map(device => device.path).join(', ')}`,
				);
			});
		}

		return boardsWithPorts;
	} catch (error) {
		log.warn('Could not get known boards with ports', { error });
		return [];
	}
}
