import {
	BOARDS,
	Flasher,
	getConnectedPorts,
	type BoardName,
	type PortInfo,
} from '@microflow/flasher';
import type { Edge, Node } from '@xyflow/react';
import { app, ipcMain, Menu, session } from 'electron';
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

	log.debug('[FLOW] <request>', timer.duration);

	await ensureRunnerProcess(data.nodes, data.edges, data.ip);

	log.debug('[FLOW] <send>', runnerProcess?.pid, timer.duration);
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
			log.debug('[CHECK] <start>', board, port.path, timer.duration);

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
				log.warn('[CHECK] <error>', board, port.path, error);
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
							await flashBoard(board, port);
							return checkBoardOnPort(port, board);
						} catch (error) {
							reject(error);
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
			resolve();
		} catch (flashError) {
			log.error('[FLASH] <error>', flashError, flashTimer.duration);
			reject(new Error(getRandomMessage('wait')));
		}
	});
}

ipcMain.on('ipc-external-value', (_event, data: { nodeId: string; value: unknown }) => {
	log.debug('[EXTERNAL] <send>', data);
	runnerProcess?.send({ type: 'setExternal', nodeId: data.nodeId, value: data.value });
});

/**
 * Converts a USB device product ID (number) to a lowercase hex string for matching
 */
function productIdToHex(productId: number): string {
	return productId.toString(16).padStart(4, '0').toLowerCase();
}

/**
 * Checks if a USB device matches any known board by product ID
 */
function isKnownBoard(productId: number): boolean {
	const productIdHex = productIdToHex(productId);
	return BOARDS.some(board => board.productIds.includes(productIdHex as never));
}

/**
 * Checks if the currently connected port still exists
 */
async function checkConnectedPort() {
	if (!connectedPort) return;

	const ports = await getConnectedPorts();
	const portStillExists = ports.find(({ path }) => path === connectedPort?.path);

	if (!portStillExists) {
		log.debug('[PORTS] <disconnected>', connectedPort?.path);
		sendMessageToRenderer<Board>('ipc-board', {
			success: true,
			data: { type: 'close', message: `${connectedPort?.path} is no longer connected` },
		});
		await killRunnerProcess();
	}
}

/**
 * Sets up device event listeners using Electron's native session API
 * Uses serial port events for Arduino devices (which appear as serial ports)
 */
function setupUSBDeviceListeners() {
	const defaultSession = session.defaultSession;

	// Set up device permission handler to automatically grant permissions
	defaultSession.setDevicePermissionHandler(details => {
		log.debug('[DEVICE] <permission-request>', {
			deviceType: details.deviceType,
			origin: details.origin,
			device: details.device,
		});

		// Auto-grant permissions for serial ports (Arduino devices)
		if (details.deviceType === 'serial') {
			return true;
		}

		// Auto-grant permissions for USB devices if they match known boards
		if (details.deviceType === 'usb' && details.device) {
			const productId = (details.device as any).productId;
			if (productId && isKnownBoard(productId)) {
				return true;
			}
		}

		return false;
	});

	// Handle select-serial-port event - this enables serial port monitoring
	defaultSession.on('select-serial-port', (event, portList, webContents, callback) => {
		log.debug('[SERIAL] <select-port>', {
			portCount: portList.length,
			ports: portList.map(p => ({
				portId: p.portId,
				portName: p.portName,
				displayName: p.displayName,
			})),
		});

		// Cancel the selection - we handle port selection ourselves
		// Note: serial-port-added/removed events only fire when handling this event
		event.preventDefault();
		// Pass empty string to cancel the selection
		callback('');
	});

	// Handle serial port added (Arduino devices appear as serial ports)
	defaultSession.on('serial-port-added', async (_event, port) => {
		log.debug('[SERIAL] <port-added>', {
			portId: port.portId,
			portName: port.portName,
			displayName: port.displayName,
			vendorId: port.vendorId,
			productId: port.productId,
		});

		// Check if this is a known board
		// port.productId is a number (USB product ID)
		const productId = typeof port.productId === 'number' ? port.productId : undefined;
		if (productId !== undefined && isKnownBoard(productId)) {
			log.debug('[SERIAL] <known-board-added>', productIdToHex(productId), port.portName);

			// Wait a bit for the port to be fully available
			setTimeout(async () => {
				const ports = await getConnectedPorts();
				const matchingPort = ports.find(p => {
					// Try to match by port name/path or product ID
					if (p.path === port.portName) return true;
					const portProductId = p.productId || p.pnpId;
					if (portProductId && productId !== undefined) {
						return productIdToHex(productId) === portProductId.toLowerCase();
					}
					return false;
				});

				if (matchingPort) {
					log.debug('[PORTS] <new>', matchingPort.path);
					sendMessageToRenderer<Board>('ipc-board', {
						success: true,
						data: { type: 'connect', message: 'New port connected' },
					});
				}
			}, 500);
		}
	});

	// Handle serial port removed
	defaultSession.on('serial-port-removed', async (_event, port) => {
		log.debug('[SERIAL] <port-removed>', {
			portId: port.portId,
			portName: port.portName,
			displayName: port.displayName,
		});

		// Check if this was the connected port
		if (
			connectedPort &&
			(connectedPort.path === port.portName || connectedPort.path === port.displayName)
		) {
			log.debug('[PORTS] <disconnected>', connectedPort.path);
			sendMessageToRenderer<Board>('ipc-board', {
				success: true,
				data: { type: 'close', message: `${connectedPort.path} is no longer connected` },
			});
			await killRunnerProcess();
		}
	});

	// Handle serial port revoked
	defaultSession.on('serial-port-revoked', async (_event, details) => {
		log.debug('[SERIAL] <port-revoked>', details);

		// When a port is revoked, check if our connected port is still accessible
		if (connectedPort) {
			const ports = await getConnectedPorts();
			const portStillExists = ports.find(({ path }) => path === connectedPort?.path);

			if (!portStillExists) {
				log.debug('[SERIAL] <port-revoked>', connectedPort.path);
				sendMessageToRenderer<Board>('ipc-board', {
					success: true,
					data: { type: 'close', message: `${connectedPort.path} access was revoked` },
				});
				await killRunnerProcess();
			}
		}
	});

	// Also listen to USB device events as a fallback (though they may not fire for serial devices)
	defaultSession.on('usb-device-added', async (_event, device) => {
		log.debug('[USB] <device-added>', {
			vendorId: device.vendorId,
			productId: device.productId,
			serialNumber: device.serialNumber,
		});

		// Check if this is a known board
		if (isKnownBoard(device.productId)) {
			log.debug('[USB] <known-board-added>', productIdToHex(device.productId));

			// Wait a bit for the serial port to be created
			setTimeout(async () => {
				const ports = await getConnectedPorts();
				const newPorts = ports.filter(port => {
					const portProductId = port.productId || port.pnpId;
					if (!portProductId) return false;
					return productIdToHex(device.productId) === portProductId.toLowerCase();
				});

				if (newPorts.length > 0) {
					log.debug('[PORTS] <new>', newPorts.map(p => p.path).join(', '));
					sendMessageToRenderer<Board>('ipc-board', {
						success: true,
						data: { type: 'connect', message: 'New port connected' },
					});
				}
			}, 500);
		}
	});

	defaultSession.on('usb-device-removed', async (_event, device) => {
		log.debug('[USB] <device-removed>', {
			vendorId: device.vendorId,
			productId: device.productId,
			serialNumber: device.serialNumber,
		});

		// Check if this is a known board
		if (isKnownBoard(device.productId)) {
			log.debug('[USB] <known-board-removed>', productIdToHex(device.productId));

			// Check if this was the connected port
			if (connectedPort) {
				const ports = await getConnectedPorts();
				const portStillExists = ports.find(({ path }) => path === connectedPort?.path);

				if (!portStillExists) {
					log.debug('[PORTS] <disconnected>', connectedPort?.path);
					sendMessageToRenderer<Board>('ipc-board', {
						success: true,
						data: { type: 'close', message: `${connectedPort?.path} is no longer connected` },
					});
					await killRunnerProcess();
				}
			}
		}
	});

	log.debug('[DEVICE] <listeners-setup>', 'Device event listeners initialized (serial + USB)');

	// Fallback: Lightweight polling since Electron events may not fire automatically
	// These events are tied to Web Serial/USB API usage from renderer
	// We'll poll less frequently as a fallback
	startPortPolling();
}

const PORT_POLL_INTERVAL_MS = 1000; // Poll every second as fallback
let portPollingInterval: NodeJS.Timeout | null = null;
let lastKnownPorts: PortInfo[] = [];

async function startPortPolling() {
	// Initial port list
	lastKnownPorts = await getConnectedPorts();

	portPollingInterval = setInterval(async () => {
		const currentPorts = await getConnectedPorts();

		// Check for disconnected port
		if (connectedPort && !currentPorts.find(p => p.path === connectedPort?.path)) {
			log.debug('[POLL] <disconnected>', connectedPort.path);
			sendMessageToRenderer<Board>('ipc-board', {
				success: true,
				data: { type: 'close', message: `${connectedPort.path} is no longer connected` },
			});
			await killRunnerProcess();
		}

		// Check for new ports
		if (currentPorts.length > lastKnownPorts.length) {
			const newPorts = currentPorts.filter(p => !lastKnownPorts.find(lp => lp.path === p.path));

			if (newPorts.length > 0) {
				log.debug('[POLL] <new-ports>', newPorts.map(p => p.path).join(', '));
				sendMessageToRenderer<Board>('ipc-board', {
					success: true,
					data: { type: 'connect', message: 'New port connected' },
				});
			}
		}

		lastKnownPorts = currentPorts;
	}, PORT_POLL_INTERVAL_MS);

	log.debug('[POLL] <started>', `Polling every ${PORT_POLL_INTERVAL_MS}ms as fallback`);
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

		log.debug('[PORTS] <boards>', boardsWithPorts.length);
		boardsWithPorts.forEach(([board, devices]) => {
			log.debug('[PORTS] <board>', board, devices.map(device => device.path).join(', '));
		});

		return boardsWithPorts;
	} catch (error) {
		log.warn('[PORTS] <error>', error);
		return [];
	}
}

class Timer {
	constructor(private readonly startTime = performance.now()) {}

	get duration() {
		return performance.now() - this.startTime + 'ms';
	}
}

killRunnerProcess().catch(log.debug);

app.on('before-quit', async event => {
	log.debug('[PROCESS] <before-quit>', event);
	void killRunnerProcess();
});

function waitForMainWindow() {
	if (mainWindowReady) {
		setupUSBDeviceListeners();
		// Initial check for connected port
		checkConnectedPort();
		return;
	}

	setTimeout(waitForMainWindow, 50);
}

waitForMainWindow();
