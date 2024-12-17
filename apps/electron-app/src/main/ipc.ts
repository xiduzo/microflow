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
import { BoardResult, IpcResponse, UploadResponse, UploadedCodeMessage } from '../common/types';
import { exportFlow } from './file';

// ipcMain.on("shell:open", () => {
//   const pageDirectory = __dirname.replace('app.asar', 'app.asar.unpacked')
//   const pagePath = path.join('file://', pageDirectory, 'index.html')
//   shell.openExternal(pagePath)
// })
//

const processes = new Map<number, UtilityProcess>();

ipcMain.on('ipc-export-flow', async (_event, data: { nodes: Node[]; edges: Edge[] }) => {
	await exportFlow(data.nodes, data.edges);
});

ipcMain.on('ipc-menu', async (_event, data: { action: string; args: any }) => {
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
	killRunningProcesses();
	log.debug('[CHECK] requested to check board', data);

	if (data.ip) {
		log.debug(`Checking board on IP ${data.ip}`);
		checkBoardOnPort(event, { path: data.ip });
		return;
	}

	const boardsAndPorts = await getKnownBoardsWithPorts();

	let connectedPort: PortInfo | undefined;

	checkBoard: for (const [board, ports] of boardsAndPorts) {
		for (const port of ports) {
			void sniffPorts(event, { connectedPort: port });
			event.reply('ipc-check-board', {
				success: true,
				data: { type: 'info', port: port.path },
			} satisfies IpcResponse<BoardResult>);

			log.debug(`[CHECK] checking board ${board} on path ${port.path}`);

			try {
				await checkBoardOnPort(event, port, board);
				connectedPort = port;
				event.reply('ipc-check-board', {
					success: true,
					data: { type: 'ready', port: port.path },
				} satisfies IpcResponse<BoardResult>);
				break checkBoard;
			} catch (error) {
				log.debug('[CHECK] [ERROR]', board, port, error);
				event.reply('ipc-check-board', {
					success: false,
					error: (error as any)?.message ?? 'Unknown error',
				} satisfies IpcResponse<BoardResult>);
			}
		}
	}

	void sniffPorts(event, { connectedPort });
});

async function checkBoardOnPort(
	event: IpcMainEvent,
	port: Pick<PortInfo, 'path'>,
	board?: BoardName,
) {
	killRunningProcesses();
	const filePath = join(__dirname, 'workers', 'check.js');

	return new Promise<void>((resolve, reject) => {
		const checkProcess = utilityProcess.fork(filePath, [port.path], {
			serviceName: 'Microflow studio - microcontroller validator',
			stdio: 'pipe',
		});

		checkProcess.on('spawn', () => {
			log.debug('[CHECK] [SPAWNED]', checkProcess.pid);
			processes.set(Number(checkProcess.pid), checkProcess);
		});

		checkProcess.on('exit', code => {
			log.debug('[CHECK] [EXITED]', code);
			checkProcess.kill();
		});

		checkProcess.stdout?.on('data', async (message: Buffer) => {
			const stringData = message.toString('utf-8');
			log.debug('[CHECK] [STDOUT]', stringData);

			try {
				const isJsonObject = stringData.match(/\{.*\}/)?.[0];
				if (!isJsonObject) return;
				const data = JSON.parse(isJsonObject) as BoardResult;
				log.warn('[CHECK] [STDOUT] [TYPE]', data.type);

				switch (data.type) {
					case 'error':
						log.debug('[CHECK] [ERROR]', board);
						try {
							// When no board is passed, we assume it is a board on TCP
							if (!board) return reject(new Error(data.message ?? stringData));
							await flashBoard(board, port);
							resolve();
						} catch (error) {
							reject(error);
						}
						break;
					case 'close':
					case 'exit':
					case 'fail':
						checkProcess.kill();
						reject(new Error(data.message ?? stringData));
					case 'ready':
						log.debug('boad ready');
						checkProcess.kill();
						resolve();
						break;
				}
			} catch (e) {
				log.warn('[CHECK] [STDOUT] [ERROR]', e);
				// Silent error for parsing errors
			}
		});

		checkProcess.stderr?.on('data', data => {
			log.debug('[CHECK] [STDERR]', data);

			checkProcess.kill();
			event.reply('ipc-check-board', {
				success: false,
				error: data.toString(),
			} satisfies IpcResponse<BoardResult>);
		});
	});
}

ipcMain.on('ipc-upload-code', async (event, data: { code: string; port: string }) => {
	killRunningProcesses();
	log.info(`Uploading code to port ${data.port}`);

	if (!data.port) {
		log.error('No port path provided for uploading code');
		event.reply('ipc-upload-code', {
			error: 'No port path provided',
			success: false,
		} satisfies IpcResponse<UploadResponse>);
		return;
	}

	const filePath = join(__dirname, 'temp.js');
	writeFile(filePath, data.code, error => {
		if (error) {
			log.error('write file error', { error });
			event.reply('ipc-upload-code', {
				error: error.message,
				success: false,
			} satisfies IpcResponse<UploadResponse>);
			return;
		}

		const uploadProcess = utilityProcess.fork(filePath, [data.port], {
			serviceName: 'Microflow studio - microcontroller runner',
			stdio: 'pipe',
		});

		uploadProcess.on('spawn', () => {
			log.debug('[UPLOAD] [SPAWNED]', uploadProcess.pid);
			processes.set(Number(uploadProcess.pid), uploadProcess);
			latestUploadProcessId = uploadProcess.pid;
		});

		uploadProcess.on('exit', code => {
			log.debug('[UPLOAD] [EXITED]', code);
		});

		uploadProcess.stdout?.on('data', data => {
			log.info('[UPLOAD] [STDOUT]', {
				data: data.toString(),
			});
		});

		uploadProcess.stderr?.on('data', data => {
			log.error('[UPLOAD] [STDERR]', {
				data: data.toString(),
			});
			uploadProcess?.kill();
			// TODO: inform the renderer
		});

		uploadProcess.on('message', (message: UploadedCodeMessage | UploadResponse) => {
			if ('type' in message) {
				switch (message.type) {
					case 'error':
					case 'exit':
					case 'fail':
					case 'close':
						uploadProcess?.kill();
						event.reply('ipc-upload-code', {
							success: false,
							error: message.message ?? 'Unknown error',
						} satisfies IpcResponse<UploadResponse>);
						break;
					case 'ready':
						event.reply('ipc-upload-code', {
							success: true,
							data: message,
						} satisfies IpcResponse<UploadResponse>);
						break;
					default:
						log.debug('Not handling message', { message });
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

let latestUploadProcessId: number | undefined;
ipcMain.on('ipc-external-value', (_event, data: { nodeId: string; value: unknown }) => {
	const process = Array.from(processes).find(
		([_pid, process]) => process.pid === latestUploadProcessId,
	);
	if (!process) {
		log.debug('Tried to set external value while no upload process is running');
		return;
	}

	const [_pid, runner] = process;
	runner.postMessage(data);
});

async function flashBoard(board: BoardName, port: Pick<PortInfo, 'path'>): Promise<void> {
	killRunningProcesses();
	log.debug(`[FLASH] flashing firmata to ${board} on ${port.path}`);

	const firmataPath = resolve(__dirname, 'hex', board, 'StandardFirmata.cpp.hex');

	// Check if file exists
	if (!existsSync(firmataPath)) {
		log.error(`[FLASH] Firmata file not found at ${firmataPath}`);
		return;
	}

	return new Promise(async (resolve, reject) => {
		log.debug(`[FLASH] Flashing firmata from ${firmataPath}`);
		try {
			await new Flasher(board, port.path).flash(firmataPath);
			resolve();
		} catch (flashError) {
			log.error(`[FLASH] Unable to flash ${board} on ${port.path} using ${firmataPath}`, {
				flashError,
			});
			reject(flashError);
		}
	});
}

let portSniffer: NodeJS.Timeout | null = null;
const PORT_SNIFFER_INTERVAL_IN_MS = 250;

async function sniffPorts(
	event: IpcMainEvent,
	options: {
		connectedPort?: Pick<PortInfo, 'path'>;
		portsConnected?: PortInfo[];
	} = {},
) {
	portSniffer && clearTimeout(portSniffer);

	const ports = await getConnectedPorts();
	// Check if the connected port is disconnected
	if (options.connectedPort && !ports.find(({ path }) => path === options.connectedPort?.path)) {
		event.reply('ipc-check-board', {
			success: true,
			data: { type: 'close', message: 'Connected port is no longer connected' },
		} satisfies IpcResponse<BoardResult>);
		return;
	}

	// Check if the connected port amount has changed
	if (options.portsConnected?.length && ports.length !== options.portsConnected?.length) {
		event.reply('ipc-check-board', {
			success: true,
			data: { type: 'info', message: 'Ports have changed' },
		} satisfies IpcResponse<BoardResult>);
		return;
	}

	options.portsConnected = ports;

	portSniffer = setTimeout(() => {
		sniffPorts(event, options);
	}, PORT_SNIFFER_INTERVAL_IN_MS);
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

function killRunningProcesses() {
	Array.from(processes).forEach(([pid, utilityProcess]) => {
		utilityProcess.removeAllListeners();

		if (!utilityProcess.kill()) {
			log.warn('[PROCESS] Could not kill process', { pid, utilityProcess });
		}

		processes.delete(pid);
	});
}
