import http from 'http';
import { Server } from 'socket.io';
import { bin } from 'cloudflared';
import { ChildProcess, spawn } from 'node:child_process';
import { handleSocket } from './socket-handle';
import log from 'electron-log/node';

const PORT = 9876;

log.debug('[SOCKET] cloudflared binary path', bin);

let socketServer: Server | null = null;
function createSocketServer(tunnel: string) {
	return new Promise<Server>(resolve => {
		// TODO check if port is already in use and used by electron --> close it
		const httpServer = http.createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('Socket server is running');
		});

		const io = new Server(httpServer, {
			cors: {
				origin: [`http://localhost:${PORT}`, tunnel],
				methods: ['GET', 'POST'],
			}
		});

		io.on('connection', socket => handleSocket(socket, io!));
		io.on('close', () => {
			log.debug('[SOCKET] Socket server closed');
			socketServer = null;
		});
		io.on('error', error => {
			log.error('[SOCKET] Socket server error', error);
		});

		socketServer = io;

		httpServer.listen(PORT, () => {
			log.debug(`[SOCKET] Http server listening on port ${PORT}`);
			resolve(io);
		});
		httpServer.on('close', () => {
			log.debug('[SOCKET] Http server closed');
			socketServer = null;
		});
	});
}

async function processLogs(output: string) {
	const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
	if (urlMatch) return Promise.resolve(urlMatch[0]);
}

let cloudflaredProcess: ChildProcess | null = null;
async function createTunnel() {
	return new Promise<string>(resolve => {
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
				'[SOCKET]To enable cloudflared, ensure the binary is installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/',
			);
			stopSocketTunnel();
		});
	});
}

async function initSocketTunnel() {

	const tunnel = await createTunnel();
	await createSocketServer(tunnel);

	return tunnel;
}

async function stopSocketTunnel() {
	cloudflaredProcess?.kill();
	socketServer?.close();
}

export { initSocketTunnel, stopSocketTunnel };
