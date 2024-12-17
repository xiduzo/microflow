const { app } = require('electron');
const { updateElectronApp } = require('update-electron-app');
const path = require('node:path');
import logger from 'electron-log/node';

import handleSquirrelEvent from '@microflow/utils/handleSquirrelEvent';
import './main/ipc';
import { addAppHandlers } from './main/app';

updateElectronApp({ logger: logger });

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
		addAppHandlers();
	}
}
