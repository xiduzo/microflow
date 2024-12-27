import { BrowserWindow } from 'electron';
import { join } from 'path';
import { createMenu } from './menu';

export let mainWindow: BrowserWindow | null = null;

export const createWindow = () => {
	mainWindow = new BrowserWindow({
		width: 1024,
		minWidth: 1024,
		height: 768,
		minHeight: 768,
		webPreferences: {
			preload: join(__dirname, 'preload.js'),
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

	mainWindow.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
};
