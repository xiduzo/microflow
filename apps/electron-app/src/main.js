const { app } = require('electron');
const { updateElectronApp } = require('update-electron-app');
const path = require('node:path');
import logger from 'electron-log/node';
import { BrowserWindow } from 'electron';

import handleSquirrelEvent from '@microflow/utils/handleSquirrelEvent';
import './main/ipc';
import { createMenu } from './main/menu';
import { handleDeepLink } from './main/deepLink';

updateElectronApp({ logger: logger });

let mainWindow;

if (process.defaultApp) {
	if (process.argv.length >= 2) {
		app.setAsDefaultProtocolClient('electron-fiddle', process.execPath, [
			path.resolve(process.argv[1]),
		]);
	}
} else {
	app.setAsDefaultProtocolClient('electron-fiddle');
}

if (!handleSquirrelEvent()) {
	if (!app.requestSingleInstanceLock()) {
		app.quit();
	} else {
		app.on('second-instance', (_event, commandLine, _workingDirectory) => {
			// Someone tried to run a second instance, we should focus our window.
			if (mainWindow) {
				if (mainWindow.isMinimized()) mainWindow.restore();
				mainWindow.focus();
			}

			logger.log('commandLine', _event, commandLine);
			handleDeepLink(mainWindow, commandLine.pop().slice(0, -1) ?? '');
		});

		app.whenReady().then(() => {
			createWindow();
		});

		// MacOS
		app.on('open-url', (_event, url) => {
			handleDeepLink(mainWindow, url);
		});

		app.on('activate', () => {
			// On OS X it's common to re-create a window in the app when the
			// dock icon is clicked and there are no other windows open.
			if (BrowserWindow.getAllWindows().length === 0) {
				createWindow();
			}
		});
	}
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1024,
		minWidth: 1024,
		height: 768,
		minHeight: 768,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	createMenu(mainWindow);

	if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
		mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
		mainWindow.webContents.openDevTools();
		return;
	}

	mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});
