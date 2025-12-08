import {
	BOARDS,
	Flasher,
	getConnectedPorts,
	UnableToOpenSerialConnection,
	type BoardName,
	type PortInfo,
} from '@microflow/flasher';
import type { Edge, Node } from '@xyflow/react';
import { fork, ChildProcess } from 'child_process';
import { sendMessageToRenderer } from './window';
import { Board, IpcResponse, UploadedCodeMessage } from '../common/types';
import { getRandomMessage } from '../common/messages';
import log from 'electron-log/node';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import {
	PortDisconnectedError,
	getConnectedPort,
	setConnectedPort,
	getKnownBoardsWithPorts,
} from './port-manager';
import { Timer } from './utils';

const ipRegex = new RegExp(
	/^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/
);

let runnerProcess: ChildProcess | undefined;
let lastUsedPinsHash: string | null = null;

/**
 * Gets the current runner process
 */
export function getRunnerProcess(): ChildProcess | undefined {
	return runnerProcess;
}

/**
 * Kills the runner process and clears the connected port
 */
export async function killRunnerProcess() {
	runnerProcess?.kill('SIGKILL');
	runnerProcess = undefined;
	setConnectedPort(undefined);
	await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for the process to die
}

async function checkPortError(error: unknown, portPath: string, context: string = 'operation') {
	if (error instanceof PortDisconnectedError) {
		throw error;
	}

	// Check if it's a port-related error
	const isPortError =
		error instanceof UnableToOpenSerialConnection ||
		(error instanceof Error &&
			(error.message.includes('No such file or directory') ||
				error.message.includes('cannot open')));

	if (isPortError) {
		const ports = await getConnectedPorts();
		const portStillExists = ports.find(p => p.path === portPath);

		if (!portStillExists) {
			throw new PortDisconnectedError(portPath, `Port ${portPath} disconnected during ${context}`);
		}
	}

	// If port still exists or it's not a port error, let the original error propagate
}

/**
 * Checks if pins have changed between flow executions
 */
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

export async function ensureRunnerProcess(nodes: Node[], edges: Edge[], ip?: string) {
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

export async function startRunnerProcess(ip?: string) {
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
			log.debug('[CHECK] <start>', board, port.path, timer.duration);

			try {
				sendMessageToRenderer<Board>('ipc-board', {
					success: true,
					data: { type: 'info', port: port.path, message: `Connecting to ${port.path}` },
				});

				await checkBoardOnPort(port, board);
				setConnectedPort(port);
				log.debug(`[CHECK] <connected> ${port.path}`, timer.duration);
				break checkBoard;
			} catch (error) {
				await killRunnerProcess();

				// If port was disconnected, skip it and continue checking other ports
				if (error instanceof PortDisconnectedError) {
					log.warn('[CHECK] <port-disconnected>', board, port.path, error.message);
					sendMessageToRenderer<Board>('ipc-board', {
						success: true,
						data: { type: 'info', message: `${port.path} disconnected, checking other boards...` },
					});
					continue; // Continue to next port
				}

				log.warn('[CHECK] <error>', board, port.path, error);
				sendMessageToRenderer<Board>('ipc-board', {
					success: true,
					data: { type: 'info', message: (error as any).message ?? getRandomMessage('wait') },
				});
			}
		}
	}

	if (!getConnectedPort()) {
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

async function checkBoardOnPort(port: Pick<PortInfo, 'path'>, board: BoardName) {
	await killRunnerProcess();

	const timer = new Timer();
	const filePath = join(__dirname, 'workers', 'runner.js');

	return new Promise((resolve, reject) => {
		log.debug('[RUNNER] <create>', filePath, timer.duration);
		runnerProcess = fork(filePath, [port.path], {
			// serviceName: 'Microflow studio - microcontroller validator',
			stdio: 'pipe',
		});

		runnerProcess.on('spawn', () => {
			log.debug('[RUNNER] <spawn>', runnerProcess?.pid, timer.duration);
		});

		runnerProcess.stderr?.on('data', async data => {
			log.debug('[RUNNER] <stderr>', runnerProcess?.pid, timer.duration, data.toString());
			sendMessageToRenderer<Board>('ipc-board', {
				success: false,
				error: data.toString(),
			});
		});

		runnerProcess.stdout?.on('data', async data => {
			log.debug('[RUNNER] <stdout>', runnerProcess?.pid, timer.duration, data.toString());
		});

		async function handleMessage(data: Board | UploadedCodeMessage) {
			// log.debug('[RUNNER] <message>', runnerProcess?.pid, data.type, timer.duration);
			try {
				switch (data.type) {
					case 'message':
						sendMessageToRenderer<UploadedCodeMessage>('ipc-microcontroller', {
							success: true,
							data: data,
						});
						break;
					case 'error':
						log.warn(`[RUNNER] <${data.type}>`, runnerProcess?.pid, data.message, timer.duration);
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
							await flashFirmataToBoard(board, port);
							return checkBoardOnPort(port, board);
						} catch (error) {
							try {
								await checkPortError(error, port.path, 'flashing');
								// Port still exists or not a port error - reject with original error
								reject(error);
							} catch (portError) {
								// Port disconnected or already PortDisconnectedError - reject with port error
								reject(portError);
							}
						} finally {
							if (notificationTimeout) clearTimeout(notificationTimeout);
						}
						break;
					case 'close':
					case 'exit':
					case 'fail':
						log.warn(`[RUNNER] <${data.type}>`, runnerProcess?.pid, data.message, timer.duration);
						reject(new Error(data.message ?? 'Unknown error'));
						break;
					case 'ready':
						log.debug(`[RUNNER] <${data.type}>`, runnerProcess?.pid, timer.duration);
						sendMessageToRenderer<Board>('ipc-board', {
							success: true,
							data: { type: 'ready', port: port.path, pins: data.pins },
						});
						resolve(null);
						break;
				}
			} catch (e) {
				reject(e);
			}
		}

		runnerProcess?.on('message', handleMessage);
	});
}

async function flashFirmataToBoard(board: BoardName, port: Pick<PortInfo, 'path'>) {
	const flashTimer = new Timer();

	const firmataPath = resolve(__dirname, 'hex', board, 'StandardFirmata.ino.hex');

	// Check if file exists
	if (!existsSync(firmataPath)) {
		log.error('[FLASH] <error>', 'Firmata file not found', firmataPath);
		throw new Error(`[FLASH] Firmata file not found at ${firmataPath}`);
	}

	await killRunnerProcess();
	log.debug('[FLASH] <start>', firmataPath, board, port.path, flashTimer.duration);
	return new Promise(async (resolve, reject) => {
		try {
			log.debug(`[FLASH] <start>`, flashTimer.duration);
			await new Flasher(board, port.path).flash(firmataPath);
			log.debug('[FLASH] <done>', flashTimer.duration);
			resolve(null);
		} catch (flashError) {
			log.error('[FLASH] <error>', flashError, flashTimer.duration);

			try {
				await checkPortError(flashError, port.path, 'flashing');
				// Port still exists but couldn't open - preserve original error
				reject(flashError);
			} catch (portError) {
				// Port disconnected or already PortDisconnectedError - reject with port error
				reject(portError);
			}
		}
	});
}
