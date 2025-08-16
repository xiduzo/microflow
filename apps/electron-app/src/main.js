import { app } from 'electron';
import { updateElectronApp } from 'update-electron-app';
import path from 'node:path';
import logger from 'electron-log/node';
import { BrowserWindow } from 'electron';

import handleSquirrelEvent from '@microflow/utils/handleSquirrelEvent';
import './main/ipc';
import { createMenu } from './main/menu';
import { handleDeepLink } from './main/deepLink';

updateElectronApp({ logger: logger });

/**
 * @type {BrowserWindow[]}
 */
let windows = [];

/**
 * @type {BrowserWindow | null}
 */
let mainWindow;

// Check if we're in development mode
const isDevelopment = !!app.isPackaged;

if (process.defaultApp) {
	if (process.argv.length >= 2) {
		app.setAsDefaultProtocolClient('microflow-studio', process.execPath, [
			path.resolve(process.argv[1]),
		]);
	}
} else {
	app.setAsDefaultProtocolClient('microflow-studio');
}

if (!handleSquirrelEvent()) {
	// Only enforce single instance in production
	if (!isDevelopment && !app.requestSingleInstanceLock()) {
		app.quit();
	} else {
		// In development, allow multiple instances but still handle second instance
		if (!isDevelopment) {
			app.on('second-instance', (_event, commandLine, _workingDirectory) => {
				// Someone tried to run a second instance, we should focus our window.
				if (mainWindow) {
					if (mainWindow.isMinimized()) mainWindow.restore();
					mainWindow.focus();
				}

				recreateWindowWhenNeeded().then(() => {
					handleDeepLink(mainWindow, commandLine.pop().slice(0, -1) ?? '');
				});
			});
		}

		app.whenReady().then(async () => {
			const window = await createWindow();
			createMenu(window, createWindow);
		});

		// MacOS
		app.on('open-url', (_event, url) => {
			recreateWindowWhenNeeded().then(() => {
				handleDeepLink(mainWindow, url);
			});
		});

		app.on('activate', () => {
			// On OS X it's common to re-create a window in the app when the
			// dock icon is clicked and there are no other windows open.
			recreateWindowWhenNeeded();
		});
	}
}

async function recreateWindowWhenNeeded() {
	if (windows.length === 0) {
		await createWindow();
		await new Promise(resolve => setTimeout(resolve, 1000));
	}

	return Promise.resolve();
}

export async function createWindow() {
	const window = new BrowserWindow({
		width: 1024,
		minWidth: 1024,
		height: 768,
		minHeight: 768,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			backgroundThrottling: false,
		},
		// Add a title to distinguish windows in development
		title: isDevelopment
			? `Microflow Studio (Dev) - Window ${windows.length + 1}`
			: 'Microflow Studio',
	});

	// Track the window
	windows.push(window);

	// Set as main window if it's the first one
	if (!mainWindow) {
		mainWindow = window;
	}

	if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
		await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
		window.webContents.openDevTools();
	} else {
		await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
	}

	window.on('closed', () => {
		// Remove from windows array
		const index = windows.indexOf(window);
		if (index > -1) {
			windows.splice(index, 1);
		}

		// Update main window if this was the main window
		if (window === mainWindow) {
			mainWindow = windows.length > 0 ? windows[0] : null;
		}
	});

	return window;
}

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});
