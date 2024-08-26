import {
	BOARDS,
	Flasher,
	getConnectedPorts,
	type BoardName,
	type PortInfo,
} from '@microflow/flasher';
import { ipcMain, IpcMainEvent, Menu, utilityProcess, UtilityProcess } from 'electron';
import log from 'electron-log/node';
import { existsSync, writeFile } from 'fs';
import { join, resolve } from 'path';
import { BoardCheckResult, UploadCodeResult, UploadedCodeMessage } from '../common/types';

let childProcess: UtilityProcess | null = null;

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

	let connectedPort: PortInfo | null = null;

	// Check board on all ports which match the known product IDs
	const boardsAndPorts = await getKnownBoardsWithPorts();

	log.debug('Checking boards and ports', {
		boardsAndPorts: JSON.stringify(boardsAndPorts),
	});

	const filePath = join(__dirname, 'workers', 'check.js');

	checkBoard: for (const [board, ports] of boardsAndPorts) {
		for (const port of ports) {
			log.debug(`checking board ${board} on path ${port.path}`, { filePath });

			const result = await new Promise<BoardCheckResult>(resolve => {
				childProcess = utilityProcess.fork(filePath, [port.path], {
					serviceName: 'Microflow studio - microcontroller validator',
					stdio: 'pipe',
				});

				childProcess.stderr?.on('data', data => {
					log.error('board check child process error', {
						data: data.toString(),
					});
				});

				log.debug('Child process forked', {
					filePath,
					port: port.path,
				});

				childProcess.on('message', async (message: BoardCheckResult) => {
					log.debug('board check child process process message', { message });
					if (message.type !== 'info') {
						childProcess?.kill(); // Free up the port again
						resolve(message);
						return;
					}

					// Inform info messages to the renderer
					event.reply('ipc-check-board', { ...message, port: port.path });
				});
			});

			if (result.type === 'ready') {
				// board is ready, no need to check other ports
				connectedPort = port;
				event.reply('ipc-check-board', { ...result, port: port.path });
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
					const [lastBoard, ports] = boardsAndPorts.at(-1);
					const lastPort = ports.at(-1);
					log.warn('Error flashing board', { error });
					// we should not return as we still want to sniff the ports 🐕
					if (board === lastBoard && port.path === lastPort.path) {
						event.reply('ipc-check-board', { ...result, port: port.path });
					}
				}
			}
		}
	}

	// Start sniffing ports for changes in connections
	sniffPorts(event, { connectedPort });
	childProcess?.kill();
});

ipcMain.on('ipc-upload-code', (event, code: string, portPath: string) => {
	log.info(`Uploading code to port ${portPath}`);

	if (!portPath) {
		log.warn('No port path provided for uploading code');
		return;
	}
	childProcess?.kill();

	const filePath = join(__dirname, 'temp.js');
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
			serviceName: 'Microflow studio - microcontroller runner',
			stdio: 'pipe',
		});

		childProcess.stderr?.on('data', data => {
			log.error('board check child process error', {
				data: data.toString(),
			});
		});

		childProcess.on('message', (message: UploadedCodeMessage | UploadCodeResult) => {
			if ('type' in message) {
				event.reply('ipc-upload-code', message);
				return;
			}

			event.reply('ipc-microcontroller', message);
		});
	});
});

ipcMain.on('ipc-external-value', (_event, nodeId: string, value: unknown) => {
	childProcess?.postMessage({ nodeId, value });
});

async function flashBoard(board: BoardName, port: PortInfo): Promise<void> {
	childProcess?.kill();
	log.debug(`Try flashing firmata to ${board} on ${port.path}`);

	const firmataPath = resolve(__dirname, 'hex', board, 'StandardFirmata.cpp.hex');

	// Check if file exists
	if (!existsSync(firmataPath)) {
		log.error(`Firmata file not found at ${firmataPath}`);
		return;
	}

	return new Promise(async (resolve, reject) => {
		log.debug(`Flashing firmata from ${firmataPath}`);
		try {
			await new Flasher(board, port.path).flash(firmataPath);
			resolve();
		} catch (flashError) {
			log.error(`Unable to flash ${board} on ${port.path} using ${firmataPath}`, { flashError });
			reject(flashError);
		}
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
			if (options.connectedPort && !ports.find(port => port.path === options.connectedPort.path)) {
				event.reply('ipc-check-board', {
					type: 'exit',
					port: options.connectedPort.path,
				} satisfies BoardCheckResult);
				return;
			}

			// Check if new ports are connected
			// We only care about this if we don't have a connected port
			if (!options.connectedPort && ports.length !== options.portsConnected?.length) {
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

async function getKnownBoardsWithPorts() {
	try {
		const ports = await getConnectedPorts();

		const boardsWithPorts = BOARDS.reduce(
			(acc, board) => {
				const matchingDevices = ports.filter(port => {
					const productId = port.productId || port.pnpId;
					if (!productId) return false;
					return board.productIds.includes(productId.toLowerCase() as never);
				});

				if (matchingDevices.length) {
					acc.push([board.name, matchingDevices]);
				}

				return acc;
			},
			[] as [BoardName, PortInfo[]][],
		);

		if (boardsWithPorts.length) {
			log.debug('Found boards on ports:');
			boardsWithPorts.forEach(([board, devices]) => {
				log.debug(`  - ${board} on ${devices.map(device => device.path).join(', ')}`);
			});
		}

		return boardsWithPorts;
	} catch (error) {
		log.warn('Could not get known boards with ports', { error });
		return [];
	}
}
