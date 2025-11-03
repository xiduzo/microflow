import {
	BOARDS,
	Flasher,
	getConnectedPorts,
	type BoardName,
	type PortInfo,
} from '@microflow/flasher';
import type { Edge, Node } from '@xyflow/react';
import { app, ipcMain, Menu } from 'electron';
import { fork, ChildProcess } from 'child_process';
import { mainWindowReady, sendMessageToRenderer } from './window';

import log from 'electron-log/node';
import { existsSync, writeFile } from 'fs';
import { join, resolve } from 'path';
import { Board, IpcResponse, UploadedCodeMessage } from '../common/types';
import { exportFlow } from './file';
import { getRandomMessage } from '../common/messages';

// ipcMain.on("shell:open", () => {
//   const pageDirectory = __dirname.replace('app.asar', 'app.asar.unpacked')
//   const pagePath = path.join('file://', pageDirectory, 'index.html')
//   shell.openExternal(pagePath)
// })

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

let runnerProcess: ChildProcess | undefined;
let connectedPort: PortInfo | undefined;
ipcMain.on('ipc-flow', async (event, data: { ip?: string; nodes: Node[]; edges: Edge[] }) => {
	const timer = new Timer();

	log.debug('[FLOW] requested to send flow', data, timer.duration);

	await ensureRunnerProcess(data.nodes, data.edges, data.ip);

	log.debug('[FLOW] sending flow to runner', runnerProcess?.pid, timer.duration);
	runnerProcess?.send({ type: 'flow', nodes: data.nodes, edges: data.edges });
});

async function ensureRunnerProcess(nodes: Node[], edges: Edge[], ip?: string) {
	if (!runnerProcess) return startRunnerProcess(ip);

	if (await didPinsChange(nodes)) {
		sendMessageToRenderer<Board>('ipc-board', {
			success: true,
			data: { type: 'info', message: 'Reconfiguring microcontroller...' },
		});
		await killRunnerProcess();
		await startRunnerProcess(ip);
	}
}

async function startRunnerProcess(ip?: string) {
	const timer = new Timer();

	const boardOverIp: Awaited<ReturnType<typeof getKnownBoardsWithPorts>> = [
		['BOARD_OVER_IP' as BoardName, [{ path: ip ?? '' } as PortInfo]],
	];

	const boardsAndPorts = ip ? boardOverIp : await getKnownBoardsWithPorts();

	if (!boardsAndPorts.length) {
		sendMessageToRenderer<Board>('ipc-board', {
			success: true,
			data: { type: 'close', message: 'No boards found' },
		});
		return;
	}

	checkBoard: for (const [board, ports] of boardsAndPorts) {
		for (const port of ports) {
			log.debug(`[CHECK] checking board ${board} on path ${port.path}`, timer.duration);

			try {
				sendMessageToRenderer<Board>('ipc-board', {
					success: true,
					data: { type: 'info', port: port.path, message: `Connecting to ${port.path}` },
				});

				await checkBoardOnPort(port, board);
				connectedPort = port;
				log.debug(`[CHECK] <connected> ${port.path}`, timer.duration);
				break checkBoard;
			} catch (error) {
				await killRunnerProcess();
				log.warn('[CHECK]', board, port, error);
				sendMessageToRenderer<Board>('ipc-board', {
					success: true,
					data: { type: 'info', message: (error as any).message ?? getRandomMessage('wait') },
				});
			}
		}
	}

	if (!connectedPort) {
		sendMessageToRenderer<Board>('ipc-board', {
			success: true,
			data: { type: 'warn', message: 'Unable to connect to board' },
		});
		sendMessageToRenderer<Board>('ipc-board', {
			success: true,
			data: { type: 'close', message: 'No board found' },
		});
		return;
	}
}

async function killRunnerProcess() {
	runnerProcess?.kill('SIGKILL');
	runnerProcess = undefined;
	connectedPort = undefined;
	await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for the process to die
}

let lastUsedPinsHash: string | null = null;
async function didPinsChange(nodes: Node[]) {
	const pins = nodes
		.map(node => {
			if ('pins' in node.data) return Object.values(node.data.pins as Record<string, unknown>);
			if ('pin' in node.data) return [node.data.pin];
		})
		.flat();

	// TODO: this can be a bit more efficient
	// E.g., If we add new pins, it is okay.
	const pinsHash = pins.sort().join(',');
	if (!lastUsedPinsHash || pinsHash === lastUsedPinsHash) return false;
	lastUsedPinsHash = pinsHash;
	return true;
}

const ipRegex = new RegExp(
	/^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/
);

async function checkBoardOnPort(port: Pick<PortInfo, 'path'>, board: BoardName) {
	await killRunnerProcess();

	const timer = new Timer();
	const filePath = join(__dirname, 'workers', 'runner.js');

	return new Promise<void>((resolve, reject) => {
		log.debug(`[RUNNER] creating runner from ${filePath}`, timer.duration);
		runnerProcess = fork(filePath, [port.path], {
			// serviceName: 'Microflow studio - microcontroller validator',
			stdio: 'pipe',
		});

		runnerProcess.on('spawn', () => {
			log.debug(`[RUNNER] [${runnerProcess?.pid}] <spawn>`, timer.duration);
		});

		runnerProcess.stderr?.on('data', async data => {
			log.debug(`[RUNNER] [${runnerProcess?.pid}] <stderr> ${data.toString()}`, timer.duration);
			sendMessageToRenderer<Board>('ipc-board', {
				success: false,
				error: data.toString(),
			});
		});

		runnerProcess.stdout?.on('data', async data => {
			log.debug(`[RUNNER] [${runnerProcess?.pid}] <stdout> ${data.toString()}`, timer.duration);
		});

		async function handleMessage(data: Board | UploadedCodeMessage) {
			// log.debug(`[RUNNER] [${runnerProcess?.pid}] <message> ${data.type}`, timer.duration);
			try {
				switch (data.type) {
					case 'message':
						sendMessageToRenderer<UploadedCodeMessage>('ipc-microcontroller', {
							success: true,
							data: data,
						});
						break;
					case 'error':
						let notificationTimeout: NodeJS.Timeout | null = null;
						try {
							if (ipRegex.test(port.path)) {
								return reject(new Error(data.message ?? 'Unknown error'));
							}

							// Prevents double error messages from causing multiple flashers
							runnerProcess?.off('message', handleMessage);

							notificationTimeout = setTimeout(() => {
								sendMessageToRenderer<Board>('ipc-board', {
									success: true,
									data: {
										type: 'info',
										message: getRandomMessage('wait'),
									},
								} satisfies IpcResponse<Board>);
							}, 7500);
							await flashBoard(board, port);
							return checkBoardOnPort(port, board);
						} catch (error) {
							if (notificationTimeout) clearTimeout(notificationTimeout);
							reject(error);
						}
						break;
					case 'close':
					case 'exit':
					case 'fail':
						reject(new Error(data.message ?? 'Unknown error'));
						break;
					case 'ready':
						log.debug(`[RUNNER] [${runnerProcess?.pid}] <ready>`, timer.duration);
						sendMessageToRenderer<Board>('ipc-board', {
							success: true,
							data: { type: 'ready', port: port.path, pins: data.pins },
						});
						resolve();
						break;
				}
			} catch (e) {
				reject(e);
			}
		}

		runnerProcess?.on('message', handleMessage);
	});
}

async function flashBoard(board: BoardName, port: Pick<PortInfo, 'path'>): Promise<void> {
	const flashTimer = new Timer();

	log.debug(`[FLASH] flashing firmata to ${board} on ${port.path}`, flashTimer.duration);
	// await cleanupProcesses();
	await killRunnerProcess();

	const firmataPath = resolve(__dirname, 'hex', board, 'StandardFirmata.cpp.hex');

	// Check if file exists
	if (!existsSync(firmataPath)) {
		log.error(`[FLASH] Firmata file not found at ${firmataPath}`);
		throw new Error(`[FLASH] Firmata file not found at ${firmataPath}`);
	}

	return new Promise(async (resolve, reject) => {
		try {
			log.debug(`[FLASH] Flashing firmata from ${firmataPath}`, flashTimer.duration);
			await new Flasher(board, port.path).flash(firmataPath);
			log.debug(`[FLASH] Flashing done`, flashTimer.duration);
			resolve();
		} catch (flashError) {
			log.error(
				`[FLASH] Unable to flash ${board} on ${port.path} using ${firmataPath}`,
				{
					flashError,
				},
				flashTimer.duration
			);
			reject(new Error(getRandomMessage('wait')));
		}
	});
}

ipcMain.on('ipc-external-value', (_event, data: { nodeId: string; value: unknown }) => {
	log.debug(`[EXTERNAL] setting value`, data);

	runnerProcess?.send({ type: 'setExternal', nodeId: data.nodeId, value: data.value });
});

const PORT_SNIFFER_TIMEOUT_IN_MS = 250;

async function sniffPorts(portsConnected: PortInfo[] = []) {
	const ports = await getConnectedPorts();

	// Check if the connected port is disconnected
	if (connectedPort && !ports.find(({ path }) => path === connectedPort?.path)) {
		log.debug(`[PORTS] <disconnected> ${connectedPort?.path}`);
		sendMessageToRenderer<Board>('ipc-board', {
			success: true,
			data: { type: 'close', message: `${connectedPort?.path} is no longer connected` },
		});
		await killRunnerProcess();
	}

	// Check if a new port is connected
	if (ports.length > portsConnected.length) {
		log.debug(`[PORTS] <new> ${ports.length}`);
		sendMessageToRenderer<Board>('ipc-board', {
			success: true,
			data: { type: 'connect', message: 'New port connected' },
		});
	}

	setTimeout(() => {
		sniffPorts(ports);
	}, PORT_SNIFFER_TIMEOUT_IN_MS);
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
			[] as [BoardName, PortInfo[]][]
		);

		log.debug(`Found ${boardsWithPorts.length} known boards with ports:`);
		boardsWithPorts.forEach(([board, devices]) => {
			log.debug(`  - ${board} on ${devices.map(device => device.path).join(', ')}`);
		});

		return boardsWithPorts;
	} catch (error) {
		log.warn('Could not get known boards with ports', { error });
		return [];
	}
}

class Timer {
	private start: number;
	constructor(private readonly name?: string) {
		this.start = Date.now();
	}

	get duration() {
		return `(${this.name ? this.name + ' took ' : ''}${Date.now() - this.start}ms)`;
	}
}

killRunnerProcess().catch(log.debug);

app.on('before-quit', async event => {
	log.debug(`[PROCESS] <before-quit> about to leave app`, event);
	void killRunnerProcess();
});

function waitForMainWindow() {
	if (mainWindowReady) return sniffPorts();

	setTimeout(waitForMainWindow, 50);
}

waitForMainWindow();
