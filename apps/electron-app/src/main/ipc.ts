import {
	BOARDS,
	Flasher,
	getConnectedPorts,
	type BoardName,
	type PortInfo,
} from '@microflow/flasher';
import type { Edge, Node } from '@xyflow/react';
import { ipcMain, IpcMainEvent, Menu } from 'electron';
import { fork, ChildProcess } from 'child_process';

import log from 'electron-log/node';
import { existsSync, writeFile } from 'fs';
import { join, resolve } from 'path';
import {
	BoardCheckResult,
	IpcResponse,
	UploadRequest,
	UploadResponse,
	UploadedCodeMessage,
} from '../common/types';
import { exportFlow } from './file';
import { generateCode } from '../utils/generateCode';
import { format } from 'prettier';

// ipcMain.on("shell:open", () => {
//   const pageDirectory = __dirname.replace('app.asar', 'app.asar.unpacked')
//   const pagePath = path.join('file://', pageDirectory, 'index.html')
//   shell.openExternal(pagePath)
// })
//

const processes = new Map<number, ChildProcess>();

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
	const timer = new Timer();
	log.debug('[CHECK] requested to check board', data, timer.duration);
	cleanupProcesses();

	const boardOverIp: Awaited<ReturnType<typeof getKnownBoardsWithPorts>> = [
		['BOARD_OVER_IP' as BoardName, [{ path: data.ip ?? '' } as PortInfo]],
	];

	const boardsAndPorts = data.ip ? boardOverIp : await getKnownBoardsWithPorts();

	let connectedPort: PortInfo | undefined;

	checkBoard: for (const [board, ports] of boardsAndPorts) {
		for (const port of ports) {
			void sniffPorts(event, { connectedPort: port });
			log.debug(`[CHECK] checking board ${board} on path ${port.path}`, timer.duration);

			try {
				event.reply('ipc-check-board', {
					success: true,
					data: { type: 'info', port: port.path },
				} satisfies IpcResponse<BoardCheckResult>);

				await checkBoardOnPort(port, board);
				connectedPort = port;
				event.reply('ipc-check-board', {
					success: true,
					data: { type: 'ready', port: port.path },
				} satisfies IpcResponse<BoardCheckResult>);
				break checkBoard;
			} catch (error) {
				log.warn('[CHECK]', board, port, error);

				event.reply('ipc-check-board', {
					success: false,
					error: (error as any).message ?? 'Unknown error',
				} satisfies IpcResponse<BoardCheckResult>);
			} finally {
				cleanupProcesses();
			}
		}
	}

	void sniffPorts(event, { connectedPort });
});

const ipRegex = new RegExp(
	/^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/,
);

async function checkBoardOnPort(port: Pick<PortInfo, 'path'>, board: BoardName) {
	const timer = new Timer();
	const filePath = join(__dirname, 'workers', 'check.js');

	return new Promise<void>((resolve, reject) => {
		console.debug(`[CHECK] creating check worker from ${filePath}`, timer.duration);
		const checkProcess = fork(filePath, [port.path], {
			// serviceName: 'Microflow studio - microcontroller validator',
			stdio: 'pipe',
		});

		checkProcess.on('spawn', () => {
			log.debug(`[CHECK] [${checkProcess.pid}] spawned`, timer.duration);
			processes.set(Number(checkProcess.pid), checkProcess);
		});

		checkProcess.stderr?.on('data', data => {
			log.debug('[CHECK] [${checkProcess.pid}] stderr', data.toString(), timer.duration);
			cleanupProcesses();
		});

		checkProcess.stdout?.on('data', async data => {
			log.debug(`[CHECK] [${checkProcess.pid}] stdout`, data.toString(), timer.duration);
		});

		checkProcess.on('message', async (data: UploadResponse) => {
			log.debug(`[CHECK] [${checkProcess.pid}] message: ${data.type}`, timer.duration);
			try {
				switch (data.type) {
					case 'error':
						try {
							if (ipRegex.test(port.path))
								return reject(new Error(data.message ?? 'Unknown error'));
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
						cleanupProcesses();
						resolve();
						break;
				}
			} catch (e) {
				reject(e);
			}
		});
	});
}

ipcMain.on('ipc-upload-code', async (event, data: UploadRequest) => {
	const timer = new Timer();
	log.debug(`[UPLOAD] Uploading code to port ${data.port}`, timer.duration);
	cleanupProcesses();

	log.debug(`[UPLOAD] generate code`, timer.duration);
	const code = generateCode(data.nodes as Node[], data.edges as Edge[]);

	log.debug(`[UPLOAD] prettier code`, timer.duration);
	const formattedCode = await format(code, { parser: 'babel' });

	log.debug('[UPLOAD] writing file', timer.duration);
	const filePath = join(__dirname, 'temp.js');
	writeFile(filePath, formattedCode, error => {
		// Run prettier node command against the file
		if (error) {
			log.debug('[UPLOAD] write file error', { error });
			event.reply('ipc-upload-code', {
				error: error.message,
				success: false,
			} satisfies IpcResponse<UploadResponse>);
			return;
		}

		log.debug('[UPLOAD] starting process', timer.duration);
		const uploadProcess = fork(filePath, [data.port], {
			// serviceName: 'Microflow studio - microcontroller runner',
			// stdio: 'pipe',
		});

		uploadProcess.on('spawn', () => {
			log.debug(`[UPLOAD] [${uploadProcess.pid}] spawned`, timer.duration);
			processes.set(Number(uploadProcess.pid), uploadProcess);
			latestUploadProcessId = uploadProcess.pid;
		});

		uploadProcess.on('message', (message: UploadedCodeMessage | UploadResponse) => {
			if ('type' in message) {
				log.debug(`[UPLOAD] [${uploadProcess.pid}] message: ${message.type}`, timer.duration);
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
			}

			if ('action' in message) {
				// log.debug(`[UPLOAD] [${uploadProcess.pid}] action`, message.action);
				event.reply('ipc-microcontroller', {
					data: message,
					success: true,
				} satisfies IpcResponse<UploadedCodeMessage>);
			}
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
	runner.send(data);
	// runner.postMessage(data);
});

async function flashBoard(board: BoardName, port: Pick<PortInfo, 'path'>): Promise<void> {
	const flashTimer = new Timer();

	log.debug(`[FLASH] flashing firmata to ${board} on ${port.path}`, flashTimer.duration);
	cleanupProcesses();

	const firmataPath = resolve(__dirname, 'hex', board, 'StandardFirmata.cpp.hex');

	// Check if file exists
	if (!existsSync(firmataPath)) {
		throw new Error(`[FLASH] Firmata file not found at ${firmataPath}`);
	}

	return new Promise(async (resolve, reject) => {
		log.debug(`[FLASH] Flashing firmata from ${firmataPath}`, flashTimer.duration);
		try {
			await new Flasher(board, port.path).flash(firmataPath);
			resolve();
		} catch (flashError) {
			log.error(
				`[FLASH] Unable to flash ${board} on ${port.path} using ${firmataPath}`,
				{
					flashError,
				},
				flashTimer.duration,
			);
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
		} satisfies IpcResponse<BoardCheckResult>);
		return;
	}

	// Check if the connected port amount has changed
	if (options.portsConnected?.length && ports.length !== options.portsConnected?.length) {
		event.reply('ipc-check-board', {
			success: true,
			data: { type: 'info', message: 'Ports have changed' },
		} satisfies IpcResponse<BoardCheckResult>);
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
	const timer = new Timer();
	log.debug(`[CLEANUP] started`);
	for (const [pid, childProcess] of Array.from(processes)) {
		// Killing utility processes will freeze the main process and renderer process
		// see https://github.com/electron/electron/issues/45053
		log.debug(`[CLEANUP] [${pid}] killing`, timer.duration);
		childProcess.kill('SIGKILL');
		processes.delete(pid);
		log.debug(`[CLEANUP] [${pid}] killed`, timer.duration);
	}
}

process.on('exit', async code => {
	log.debug(`[PROCESS] about to leave app`, code);
	cleanupProcesses();
});

class Timer {
	private start: number;
	constructor(private readonly name?: string) {
		this.start = Date.now();
	}

	get duration() {
		return `(${this.name ? this.name + ' took ' : ''}${Date.now() - this.start}ms)`;
	}
}
