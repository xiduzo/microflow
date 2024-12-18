import { app, BrowserWindow } from 'electron';
import { createWindow, mainWindow } from './mainWindow';
import logger from 'electron-log/node';
import { handleDeepLink } from './deepLink';

export function addAppHandlers() {
	app.on('second-instance', (_event, commandLine, _workingDirectory) => {
		// Someone tried to run a second instance, we should focus our window.
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}

		logger.log('commandLine', _event, commandLine);
		handleDeepLink(mainWindow!, commandLine.pop() ?? '');
	});

	app.on('ready', createWindow);

	// MacOS
	app.on('open-url', (_event, url) => {
		handleDeepLink(mainWindow!, url);
	});

	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') {
			app.quit();
		}
	});

	app.on('activate', () => {
		// On OS X it's common to re-create a window in the app when the
		// dock icon is clicked and there are no other windows open.
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
}
