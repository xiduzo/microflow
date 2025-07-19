import { fork, ChildProcess, spawn } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import logger from 'electron-log/node';

export class SocketServerManager {
	private socketProcess: ChildProcess | null = null;
	private isRunning = false;
	private tunnelUrl: string | null = null;

	async start() {
		if (this.isRunning) {
			logger.info('Socket server is already running');
			return;
		}

		try {
			// Determine the path to the socket server
			const socketServerPath = path.join(__dirname, '../../../packages/socket/dist/server.js');
			const socketPackagePath = path.join(__dirname, '../../../packages/socket');
			
			// Check if the built server exists, if not build it
			const fs = await import('fs');
			if (!fs.existsSync(socketServerPath)) {
				logger.info('Building socket server...');
				await this.buildSocketServer(socketPackagePath);
			}
			
			// Fork the socket server process (enables IPC messaging)
			this.socketProcess = fork(socketServerPath, [], {
				cwd: socketPackagePath,
				stdio: ['pipe', 'pipe', 'pipe', 'ipc']
			});

			this.isRunning = true;
			logger.info('Socket server process started');

			// Handle stdout
			this.socketProcess.stdout?.on('data', (data) => {
				const output = data.toString();
				logger.info(`Socket Server: ${output.trim()}`);
			});

			// Handle stderr
			this.socketProcess.stderr?.on('data', (data) => {
				const output = data.toString();
				logger.warn(`Socket Server Error: ${output.trim()}`);
				
				// Look for the tunnel URL in the stderr output
				const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
				if (urlMatch) {
					this.tunnelUrl = urlMatch[0];
					logger.info(`✅ Cloudflare tunnel ready: ${this.tunnelUrl}`);
				}
			});

			// Handle process exit
			this.socketProcess.on('close', (code) => {
				logger.info(`Socket server process exited with code ${code}`);
				this.isRunning = false;
				this.socketProcess = null;
			});

			// Handle messages from the child process
			this.socketProcess.on('message', (message: any) => {
				switch (message.type) {
					case 'tunnel-ready':
						this.tunnelUrl = message.tunnelUrl;
						logger.info(`✅ Cloudflare tunnel ready: ${this.tunnelUrl}`);
						break;
					case 'log':
						logger.info(`Socket Server [${message.logType}]: ${message.message}`);
						break;
					case 'status':
						logger.info('Socket server status received');
						break;
				}
			});

			// Handle process errors
			this.socketProcess.on('error', (error) => {
				logger.error('Socket server process error:', error);
				this.isRunning = false;
				this.socketProcess = null;
			});

		} catch (error) {
			logger.error('Failed to start socket server:', error);
			this.isRunning = false;
		}
	}

	private async buildSocketServer(socketPackagePath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const buildProcess = spawn('npm', ['run', 'build'], {
				cwd: socketPackagePath,
				stdio: ['pipe', 'pipe', 'pipe']
			});

			buildProcess.stdout?.on('data', (data) => {
				logger.info(`Socket Server Build: ${data.toString().trim()}`);
			});

			buildProcess.stderr?.on('data', (data) => {
				logger.warn(`Socket Server Build Error: ${data.toString().trim()}`);
			});

			buildProcess.on('close', (code) => {
				if (code === 0) {
					logger.info('Socket server build completed successfully');
					resolve();
				} else {
					logger.error(`Socket server build failed with code ${code}`);
					reject(new Error(`Build failed with code ${code}`));
				}
			});

			buildProcess.on('error', (error) => {
				logger.error('Socket server build error:', error);
				reject(error);
			});
		});
	}

	stop() {
		if (!this.socketProcess || !this.isRunning) {
			logger.info('Socket server is not running');
			return;
		}

		try {
			this.socketProcess.kill('SIGTERM');
			logger.info('Socket server stop signal sent');
		} catch (error) {
			logger.error('Failed to stop socket server:', error);
		}
	}

	isServerRunning() {
		return this.isRunning;
	}

	getProcess() {
		return this.socketProcess;
	}

	getTunnelUrl() {
		return this.tunnelUrl;
	}

	getShareInfo() {
		return {
			running: this.isRunning,
			tunnelUrl: this.tunnelUrl,
			localUrl: this.isRunning ? 'http://localhost:3000' : null
		};
	}
}

// Create a singleton instance
export const socketServerManager = new SocketServerManager();

// Clean up on app exit
app.on('before-quit', () => {
	socketServerManager.stop();
}); 