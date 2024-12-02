import {
	BOARDS,
	Flasher,
	getConnectedPorts,
	type BoardName,
	type PortInfo,
} from '@microflow/flasher';
import type { Edge, Node } from '@xyflow/react';
import { ipcMain, IpcMainEvent, Menu, utilityProcess, UtilityProcess } from 'electron';

import log from 'electron-log/node';
import { existsSync, writeFile } from 'fs';
import { join, resolve } from 'path';
import { BoardResult, IpcResponse, UploadResult, UploadedCodeMessage } from '../common/types';
import { exportFlow } from './file';

let childProcess: UtilityProcess | null = null;

// ipcMain.on("shell:open", () => {
//   const pageDirectory = __dirname.replace('app.asar', 'app.asar.unpacked')
//   const pagePath = path.join('file://', pageDirectory, 'index.html')
//   shell.openExternal(pagePath)
// })
//

ipcMain.on('ipc-export-flow', async (_event, data: { nodes: Node[]; edges: Edge[] }) => {
	await exportFlow(data.nodes, data.edges);
});

ipcMain.on('ipc-menu', (_event, data: { action: string; args: any }) => {
	switch (data.action) {
		case 'auto-save':
			const checked = Boolean(data.args);
			const menu = Menu.getApplicationMenu();
			if (!menu) return;

			const menuItem = menu.getMenuItemById('autosave');
			if (!menuItem) return;

			menuItem.checked = checked;
			break;
	}
});

ipcMain.on('ipc-check-board', async (event, data: { ip: string | undefined }) => {
	childProcess?.kill();

	log.debug('Checking board', { data });

	if (data.ip) {
		log.debug(`Checking board on IP ${data.ip}`);
		const result = await checkBoardOnPort(event, data.ip);
		console.log({ result });

		event.reply('ipc-check-board', {
			success: true,
			data: { ...result, port: data.ip },
		} satisfies IpcResponse<BoardResult>);

		return;
	}

	// Check board on all ports which match the known product IDs
	const boardsAndPorts = await getKnownBoardsWithPorts();

	log.debug('Checking boards and ports', {
		boardsAndPorts: JSON.stringify(boardsAndPorts),
	});

	let connectedPort: PortInfo | undefined = undefined;

	checkBoard: for (const [board, ports] of boardsAndPorts) {
		for (const port of ports) {
			log.debug(`checking board ${board} on path ${port.path}`);

			const result = await checkBoardOnPort(event, port.path);

			if (result.type === 'ready') {
				// board is ready, no need to check other ports
				connectedPort = port;
				event.reply('ipc-check-board', {
					success: true,
					data: { ...result, port: port.path },
				} satisfies IpcResponse<BoardResult>);
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
						success: true,
						data: {
							...result,
							port: port.path,
							type: 'ready',
						},
					} satisfies IpcResponse<BoardResult>);
					break checkBoard; // board is flashed with firmata, no need to check other ports
				} catch (error) {
					const next = boardsAndPorts.at(-1);
					if (!next) return;

					const [lastBoard, ports] = next;
					const lastPort = ports.at(-1);
					log.warn('Error flashing board', { error });
					// we should not return as we still want to sniff the ports 🐕
					if (board === lastBoard && port.path === lastPort?.path) {
						event.reply('ipc-check-board', {
							success: true,
							data: { ...result, port: port.path },
						} satisfies IpcResponse<BoardResult>);
					}
				}
			}
		}
	}

	// Start sniffing ports for changes in connections
	sniffPorts(event, { connectedPort });
	childProcess?.kill();
});

async function checkBoardOnPort(event: IpcMainEvent, port: string) {
	const filePath = join(__dirname, 'workers', 'check.js');

	return new Promise<BoardResult>(resolve => {
		childProcess = utilityProcess.fork(filePath, [port], {
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
			port: port,
		});

		childProcess.on('message', async (message: BoardResult) => {
			log.debug('board check child process process message', { message });
			if (message.type !== 'info') {
				childProcess?.kill(); // Free up the port again
				resolve(message);
				return;
			}

			// Inform info messages to the renderer
			event.reply('ipc-check-board', {
				success: true,
				data: { ...message, port: port },
			} satisfies IpcResponse<BoardResult>);
		});
	});
}

ipcMain.on('ipc-upload-code', (event, data: { code: string; port: string }) => {
	childProcess?.kill();
	log.info(`Uploading code to port ${data.port}`);

	if (!data.port) {
		log.warn('No port path provided for uploading code');
		return;
	}

	const filePath = join(__dirname, 'temp.js');
	writeFile(filePath, data.code, error => {
		if (error) {
			log.error('write file error', { error });
			event.reply('ipc-upload-code', {
				error: error.message,
				success: false,
			} satisfies IpcResponse<UploadResult>);
			return;
		}

		childProcess = utilityProcess.fork(filePath, [data.port], {
			serviceName: 'Microflow studio - microcontroller runner',
			stdio: 'pipe',
		});

		childProcess.stdout?.on('data', data => {
			log.info('board check child process stdout', {
				data: data.toString(),
			});
		});

		childProcess.stderr?.on('data', data => {
			log.error('board check child process error', {
				data: data.toString(),
			});
		});

		childProcess.on('message', (message: UploadedCodeMessage | UploadResult) => {
			if ('type' in message) {
				event.reply('ipc-upload-code', {
					data: message,
					success: true,
				} satisfies IpcResponse<UploadResult>);

				if (message.type === 'close') {
					childProcess?.kill();
				}
				return;
			}

			event.reply('ipc-microcontroller', {
				data: message,
				success: true,
			} satisfies IpcResponse<UploadedCodeMessage>);
		});
	});
});

ipcMain.on('ipc-external-value', (_event, data: { nodeId: string; value: unknown }) => {
	childProcess?.postMessage(data);
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
			if (options.connectedPort && !ports.find(port => port.path === options.connectedPort?.path)) {
				event.reply('ipc-check-board', {
					success: true,
					data: {
						type: 'exit',
						port: options.connectedPort.path,
					},
				} satisfies IpcResponse<BoardResult>);
				return;
			}

			// Check if new ports are connected
			// We only care about this if we don't have a connected port
			if (!options.connectedPort && ports.length !== options.portsConnected?.length) {
				event.reply('ipc-check-board', {
					success: true,
					data: {
						type: 'exit',
					},
				} satisfies IpcResponse<BoardResult>);
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
