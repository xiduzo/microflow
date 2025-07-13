import http from 'http';
import { Server } from 'socket.io';
import { bin, install } from 'cloudflared';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

if (!fs.existsSync(bin)) {
	await install(bin);
}

let tunnelUrl: string | null = null;
let cloudflaredLogs: string[] = [];

const server = http.createServer((req, res) => {
	// Handle test client route
	if (req.url === '/test') {
		res.writeHead(200, { 'Content-Type': 'text/html' });

		const testHtml = `
		<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Socket.IO Test Client</title>
			<script src="https://cdn.socket.io/4.8.1/socket.io.min.js"></script>
			<style>
				body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
				.container { background: #f5f5f5; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
				.status { padding: 10px; border-radius: 4px; margin: 10px 0; }
				.connected { background: #d4edda; color: #155724; }
				.disconnected { background: #f8d7da; color: #721c24; }
				.connecting { background: #fff3cd; color: #856404; }
				.error { background: #f8d7da; color: #721c24; }
				.log { background: #1e1e1e; color: #f0f0f0; padding: 15px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; max-height: 300px; overflow-y: auto; margin: 10px 0; }
				input, button { padding: 8px 12px; margin: 5px; border: 1px solid #ddd; border-radius: 4px; }
				button { background: #007bff; color: white; cursor: pointer; }
				button:hover { background: #0056b3; }
				button:disabled { background: #6c757d; cursor: not-allowed; }
			</style>
		</head>
		<body>
			<h1>Socket.IO Connection Test</h1>

			<div class="container">
				<h3>Connection Settings</h3>
				<input type="text" id="serverUrl" placeholder="Enter server URL" style="width: 400px;" value="${tunnelUrl || 'http://localhost:3000'}">
				<button onclick="connect()" id="connectBtn">Connect</button>
				<button onclick="disconnect()" id="disconnectBtn" disabled>Disconnect</button>
			</div>

			<div class="container">
				<h3>Connection Status</h3>
				<div id="status" class="status disconnected">Disconnected</div>
			</div>

			<div class="container">
				<h3>Test Messages</h3>
				<input type="text" id="messageInput" placeholder="Enter a message to send" style="width: 300px;">
				<button onclick="sendMessage()" id="sendBtn" disabled>Send Message</button>
			</div>

			<div class="container">
				<h3>Connection Log</h3>
				<div id="log" class="log"></div>
				<button onclick="clearLog()">Clear Log</button>
			</div>

			<script>
				let socket = null;
				let isConnected = false;

				function log(message, type = 'info') {
					const logDiv = document.getElementById('log');
					const timestamp = new Date().toLocaleTimeString();
					const logEntry = document.createElement('div');
					logEntry.innerHTML = \`<span style="color: #888;">[\${timestamp}]</span> \${message}\`;
					logDiv.appendChild(logEntry);
					logDiv.scrollTop = logDiv.scrollHeight;
				}

				function updateStatus(status, className) {
					const statusDiv = document.getElementById('status');
					statusDiv.textContent = status;
					statusDiv.className = \`status \${className}\`;
				}

				function updateButtons() {
					document.getElementById('connectBtn').disabled = isConnected;
					document.getElementById('disconnectBtn').disabled = !isConnected;
					document.getElementById('sendBtn').disabled = !isConnected;
				}

				function connect() {
					const serverUrl = document.getElementById('serverUrl').value.trim();
					if (!serverUrl) {
						alert('Please enter a server URL');
						return;
					}

					log(\`Attempting to connect to: \${serverUrl}\`, 'info');
					updateStatus('Connecting...', 'connecting');

					try {
						socket = io(serverUrl, {
							transports: ['websocket', 'polling'],
							timeout: 10000
						});

						socket.on('connect', () => {
							isConnected = true;
							updateStatus('Connected!', 'connected');
							updateButtons();
							log('✅ Successfully connected to server', 'success');
						});

						socket.on('disconnect', (reason) => {
							isConnected = false;
							updateStatus('Disconnected', 'disconnected');
							updateButtons();
							log(\`❌ Disconnected: \${reason}\`, 'error');
						});

						socket.on('connect_error', (error) => {
							isConnected = false;
							updateStatus('Connection Failed', 'error');
							updateButtons();
							log(\`❌ Connection error: \${error.message}\`, 'error');
						});

						socket.on('message', (data) => {
							log(\`📨 Received: \${data}\`, 'message');
						});

						socket.on('error', (error) => {
							log(\`❌ Socket error: \${error}\`, 'error');
						});

					} catch (error) {
						log(\`❌ Failed to create connection: \${error.message}\`, 'error');
						updateStatus('Connection Failed', 'error');
					}
				}

				function disconnect() {
					if (socket) {
						socket.disconnect();
						socket = null;
						isConnected = false;
						updateStatus('Disconnected', 'disconnected');
						updateButtons();
						log('🔌 Manually disconnected', 'info');
					}
				}

				function sendMessage() {
					if (!socket || !isConnected) {
						alert('Not connected to server');
						return;
					}

					const message = document.getElementById('messageInput').value.trim();
					if (!message) {
						alert('Please enter a message');
						return;
					}

					socket.emit('message', message);
					log(\`📤 Sent: \${message}\`, 'send');
					document.getElementById('messageInput').value = '';
				}

				function clearLog() {
					document.getElementById('log').innerHTML = '';
				}

				// Handle Enter key in message input
				document.getElementById('messageInput').addEventListener('keypress', function(e) {
					if (e.key === 'Enter') {
						sendMessage();
					}
				});

				// Handle Enter key in server URL input
				document.getElementById('serverUrl').addEventListener('keypress', function(e) {
					if (e.key === 'Enter') {
						connect();
					}
				});

				log('🚀 Socket.IO Test Client loaded. Click Connect to test the connection.', 'info');
			</script>
		</body>
		</html>
		`;

		res.end(testHtml);
		return;
	}

	// Default server info page
	res.writeHead(200, { 'Content-Type': 'text/html' });

	const html = `
		<!DOCTYPE html>
		<html>
		<head>
			<title>Socket.IO Server</title>
			<style>
				body { font-family: Arial, sans-serif; margin: 40px; }
				.url { background: #f0f0f0; padding: 10px; margin: 10px 0; border-radius: 5px; }
				.local { border-left: 4px solid #4CAF50; }
				.tunnel { border-left: 4px solid #2196F3; }
				.waiting { color: #666; font-style: italic; }
				.logs { background: #1e1e1e; color: #f0f0f0; padding: 15px; margin: 20px 0; border-radius: 5px; font-family: 'Courier New', monospace; font-size: 12px; max-height: 400px; overflow-y: auto; }
				.log-entry { margin: 2px 0; }
				.timestamp { color: #888; }
				.test-link { background: #2196F3; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px 0; }
				.test-link:hover { background: #1976D2; }
			</style>
		</head>
		<body>
			<h1>Socket.IO Server</h1>
			<div class="url local">
				<strong>Local URL:</strong> <a href="http://localhost:${PORT}" target="_blank">http://localhost:${PORT}</a>
			</div>
			<div class="url tunnel">
				<strong>Cloudflare Tunnel:</strong>
				${tunnelUrl ? `<a href="${tunnelUrl}" target="_blank">${tunnelUrl}</a>` : '<span class="waiting">Waiting for tunnel to be ready...</span>'}
			</div>
			<div style="margin: 20px 0;">
				<a href="/test" class="test-link">🧪 Test WebSocket Connection</a>
			</div>
			<div class="logs">
				<strong>Cloudflared Logs:</strong>
				${cloudflaredLogs.length > 0 ? cloudflaredLogs.map(log => `<div class="log-entry">${log}</div>`).join('') : '<div class="log-entry">No logs yet...</div>'}
			</div>
		</body>
		</html>
	`;

	res.end(html);
});

const io = new Server(server, {
	cors: {
		origin: ['http://localhost:3000'],
		methods: ['GET', 'POST'],
	},
});

io.on('connection', socket => {
	console.log('A user connected');

	// Listen for messages from the client
	socket.on('message', msg => {
		console.log('Message received:', msg);

		// Send a response back to the client
		socket.emit('message', `Server received: ${msg}`);

		// Sending data to all connected clients
		io.emit('message', `Broadcast: ${msg}`);
	});

	// Handle disconnection
	socket.on('disconnect', () => {
		console.log('A user disconnected');
	});
});

const PORT = 3000;

function processLogs(output: string, type: 'stdout' | 'stderr') {
	const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
	if (urlMatch) {
		tunnelUrl = urlMatch[0];
		console.log(`✅ Server is exposed via cloudflared: ${tunnelUrl}`);

		// Send tunnel URL to parent process
		if (process.send) {
			process.send({
				type: 'tunnel-ready',
				tunnelUrl: tunnelUrl,
			});
		}

		// Add the tunnel URL to CORS origins
		const corsOptions = io.engine.opts.cors;
		if (corsOptions && typeof corsOptions === 'object' && 'origin' in corsOptions) {
			const origins = corsOptions.origin as string[];
			if (Array.isArray(origins) && !origins.includes(tunnelUrl)) {
				origins.push(tunnelUrl);
				console.log(`✅ Added ${tunnelUrl} to CORS origins`);
			}
		}
	}

	cloudflaredLogs.push(`[${type}] ${output.trim()}`);

	// Send log to parent process
	if (process.send) {
		process.send({
			type: 'log',
			logType: type,
			message: output.trim(),
		});
	}
}

// Handle messages from parent process
if (process.send) {
	process.on('message', (message: any) => {
		if (message?.type === 'get-status') {
			process.send!({
				type: 'status',
				running: true,
				tunnelUrl: tunnelUrl,
				localUrl: `http://localhost:${PORT}`,
			});
		}
	});
}

server.listen(PORT, () => {
	console.log(`Server is running on http://localhost:${PORT}`);

	// Try to expose the server via cloudflared (optional)
	try {
		const cloudflared = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`]);

		cloudflared.stdout.on('data', data => {
			const output = data.toString();
			processLogs(output, 'stdout');
		});

		cloudflared.stderr.on('data', data => {
			const output = data.toString();
			processLogs(output, 'stderr');
		});

		cloudflared.on('close', code => {
			console.log(`Cloudflared process exited with code ${code}`);
		});

		cloudflared.on('error', error => {
			console.log('Cloudflared not available, server running locally only');
			console.log(
				'To enable cloudflared, ensure the binary is installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/',
			);
		});
	} catch (error) {
		console.log('Cloudflared not available, server running locally only');
		console.log(
			'To enable cloudflared, ensure the binary is installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/',
		);
	}
});
