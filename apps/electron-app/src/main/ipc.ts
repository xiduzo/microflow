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
import {
	BoardResult,
	IpcResponse,
	UploadRequest,
	UploadResponse,
	UploadedCodeMessage,
} from '../common/types';
import { exportFlow } from './file';
import { generateCode } from '../utils/generateCode';

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
				log.error('[CHECK]', board, port, error);
				event.reply('ipc-check-board', {
					success: false,
					error: (error as any)?.message ?? 'Unknown error',
				} satisfies IpcResponse<BoardResult>);
			}

			cleanupProcesses();
		}
	}

	void sniffPorts(event, { connectedPort });
});

async function checkBoardOnPort(
	event: IpcMainEvent,
	port: Pick<PortInfo, 'path'>,
	board?: BoardName,
) {
	cleanupProcesses();
	const filePath = join(__dirname, 'workers', 'check.js');

	return new Promise<void>((resolve, reject) => {
		const checkProcess = utilityProcess.fork(filePath, [port.path], {
			serviceName: 'Microflow studio - microcontroller validator',
			stdio: 'pipe',
		});

		checkProcess.on('spawn', () => {
			log.debug(`[CHECK] [SPAWNED] pid: ${checkProcess.pid}`);
			processes.set(Number(checkProcess.pid), checkProcess);
		});

		checkProcess.stderr?.on('data', data => {
			log.debug('[CHECK] [STDERR]', data.toString());
			cleanupProcesses();

			event.reply('ipc-check-board', {
				success: false,
				error: data.toString(),
			} satisfies IpcResponse<BoardResult>);
		});

		checkProcess.stdout?.on('data', async data => {
			log.debug('[CHECK] [STDOUT]', data.toString());
		});

		checkProcess.on('message', async (data: UploadResponse) => {
			try {
				switch (data.type) {
					case 'error':
						try {
							// When no board is passed we assume it is a board on TCP, no need to flash firmata in that case.
							if (!board) return reject(new Error(data.message ?? 'Unknown error'));
							await flashBoard(board, port);
							resolve();
						} catch (error) {
							reject(error);
						}
						break;
					case 'close':
					case 'exit':
					case 'fail':
						reject(new Error(data.message ?? 'Unknown error'));
					case 'ready':
						log.debug('boad ready');
						resolve();
						break;
				}
			} catch (e) {
				log.warn('[CHECK]', e);
				cleanupProcesses();
			}
		});
	});
}

ipcMain.on('ipc-upload-code', async (event, data: UploadRequest) => {
	log.debug(`[UPLOAD] Uploading code to port ${data.port}`);
	cleanupProcesses();

	const code = generateCode(data.nodes as Node[], data.edges as Edge[]);

	log.debug('[UPLOAD] writing file');
	const filePath = join(__dirname, 'temp.js');
	writeFile(filePath, code, error => {
		if (error) {
			log.debug('[UPLOAD] write file error', { error });
			event.reply('ipc-upload-code', {
				error: error.message,
				success: false,
			} satisfies IpcResponse<UploadResponse>);
			return;
		}

		log.debug('[UPLOAD] starting process');
		const uploadProcess = utilityProcess.fork(filePath, [data.port], {
			serviceName: 'Microflow studio - microcontroller runner',
			stdio: 'pipe',
		});

		uploadProcess.on('spawn', () => {
			log.debug(`[UPLOAD] [SPAWNED] pid: ${uploadProcess.pid}`);
			processes.set(Number(uploadProcess.pid), uploadProcess);
			latestUploadProcessId = uploadProcess.pid;
		});

		uploadProcess.stdout?.on('data', data => {
			log.info('[UPLOAD] [STDOUT]', data.toString());
		});

		uploadProcess.stderr?.on('data', data => {
			log.error('[UPLOAD] [STDERR]', data.toString());
			cleanupProcesses();
			event.reply('ipc-upload-code', {
				error: 'Unknown exception when running your flow',
				success: false,
			} satisfies IpcResponse<UploadResponse>);
		});

		uploadProcess.on('message', (message: UploadedCodeMessage | UploadResponse) => {
			if ('type' in message) {
				switch (message.type) {
					case 'error':
					case 'exit':
					case 'fail':
					case 'close':
						cleanupProcesses();
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
	cleanupProcesses();
	log.debug(`[FLASH] flashing firmata to ${board} on ${port.path}`);

	const firmataPath = resolve(__dirname, 'hex', board, 'StandardFirmata.cpp.hex');

	// Check if file exists
	if (!existsSync(firmataPath)) {
		throw new Error(`[FLASH] Firmata file not found at ${firmataPath}`);
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
		cleanupProcesses();
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

function cleanupProcesses() {
	for (const [pid, process] of Array.from(processes)) {
		process.on('exit', () => {
			log.debug(`[CLEANUP] process ${pid} exited`);
			processes.delete(pid);
		});
		// Killing utility processes will freeze the main process and renderer process
		// see https://github.com/electron/electron/issues/45053
		process.kill();
	}
}
