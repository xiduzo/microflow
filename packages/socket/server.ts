import http from 'http';
import { Server, ServerOptions } from 'socket.io';
import { bin, install } from 'cloudflared';
import fs from 'node:fs';
import { ChildProcess, spawn } from 'node:child_process';
import { handleSocket } from './src/socket-handle';

const PORT = 9876;

let socketServer: Server | null = null;
function createSocketServer() {
	return new Promise<Server>(resolve => {
		// TODO check if port is already in use and used by electron --> close it
		const httpServer = http.createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('Socket server is running');
		});

		const io = new Server(httpServer, {
			cors: getCors(),
		});

		io.on('connection', socket => handleSocket(socket, io!));
		io.on('close', () => {
			console.log('[SOCKET] Socket server closed');
			socketServer = null;
		});

		socketServer = io;

		httpServer.listen(PORT, () => {
			console.log(`[SOCKET] Http server listening on port ${PORT}`);
			resolve(io);
		});
		httpServer.on('close', () => {
			console.log('[SOCKET] Http server closed');
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
		const cloudflared = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`]);

		cloudflared.on('spawn', () => {
			cloudflaredProcess = cloudflared;
			console.log('Cloudflared process started successfully');
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
			console.log(`Cloudflared process exited with code ${code}`);
			cloudflaredProcess = null;
		});

		cloudflared.on('error', error => {
			console.log('Cloudflared not available, server running locally only');
			console.log(
				'To enable cloudflared, ensure the binary is installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/',
			);
		});
	});
}

async function installCloudflared() {
	if (!fs.existsSync(bin)) {
		await install(bin);
	}

	console.log('Cloudflared installed');
}

function getCors(tunnel?: string): ServerOptions['cors'] {
	return {
		origin: tunnel ? [`http://localhost:${PORT}`, tunnel] : [`http://localhost:${PORT}`],
		methods: ['GET', 'POST'],
	};
}

async function initSocketServer() {
	await installCloudflared();
	const io = await createSocketServer();
	const tunnel = await createTunnel();

	// add tunnel to CORS
	// This is a workaround to ensure the tunnel URL is added to the CORS origins
	// since the tunnel URL is not known until the cloudflared process starts
	// and the logs are processed.
	io.engine.opts.cors = getCors(tunnel);

	return tunnel;
}

async function stopTunnel() {
	cloudflaredProcess?.kill();
	socketServer?.close();
}

export { initSocketServer, stopTunnel };
