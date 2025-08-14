import { Server } from 'socket.io';
import { bin } from 'cloudflared';
import { ChildProcess, spawn } from 'node:child_process';
import log from 'electron-log/node';
import { handleSocket } from './handle-message';
import { Connection } from '../common/types';

const PORT = 9876;

let socketServer: Server | null = null;

const connectedClients = new Map<string, Connection>();
function createSocketServer(tunnel?: string) {
	return new Promise<Server>(resolve => {
		const io = new Server(PORT, {
			cors: {
				origin: tunnel ? [`http://localhost:${PORT}`, tunnel] : [`http://localhost:${PORT}`],
				methods: ['GET', 'POST'],
			},
		});

		io.on('connection', socket => handleSocket(socket, io, connectedClients));
		io.on('close', () => {
			log.debug('[SOCKET] Socket server closed');
			stopSocketTunnel();
		});
		io.on('error', error => {
			log.error('[SOCKET] Socket server error', error);
			stopSocketTunnel();
		});

		resolve(io);
	});
}

async function processLogs(output: string) {
	const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
	if (urlMatch) return Promise.resolve(urlMatch[0]);
}

let cloudflaredProcess: ChildProcess | null = null;
async function createTunnel() {
	return new Promise<string>(resolve => {
		log.debug('[SOCKET] cloudflared binary path', bin);

		const cloudflared = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`]);

		cloudflared.on('spawn', () => {
			cloudflaredProcess = cloudflared;
			log.debug('[SOCKET] Cloudflared process started successfully');
		});
		cloudflared.stdout.on('data', data => {
			const output = data.toString();
			processLogs(output).then(url => url && resolve(url));
		});

		cloudflared.stderr.on('data', data => {
			const output = data.toString();
			processLogs(output).then(url => url && resolve(url));
		});

		cloudflared.on('close', code => {
			log.debug(`[SOCKET] Cloudflared process exited with code ${code}`);
			stopSocketTunnel();
		});

		cloudflared.on('error', error => {
			log.warn('[SOCKET] Cloudflared not available, server running locally only', error);
			log.info(
				'[SOCKET]To enable cloudflared, ensure the binary is installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/'
			);
			stopSocketTunnel();
		});
	});
}

async function initSocketTunnel() {
	const tunnel = await createTunnel();
	socketServer = await createSocketServer(tunnel);

	return tunnel;
}

async function stopSocketTunnel() {
	cloudflaredProcess?.kill();
	cloudflaredProcess = null;
	socketServer?.close();
	socketServer = null;
	connectedClients.clear();
}

export { initSocketTunnel, stopSocketTunnel };
