import { app } from 'electron';
import { updateElectronApp } from 'update-electron-app';
import path from 'node:path';
import logger from 'electron-log/node';

import handleSquirrelEvent from '@microflow/utils/handleSquirrelEvent';
import './main/ipc';
import { createMenu } from './main/menu';
import { handleDeepLink } from './main/deepLink';
import { mainWindow, createWindow, recreateWindowWhenNeeded } from './main/window';

updateElectronApp({ logger: logger });

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
				handleSecondInstance(commandLine);
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

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});
