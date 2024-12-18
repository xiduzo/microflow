import { BrowserWindow } from 'electron';
import { join } from 'path';
import { createMenu } from './menu';

export let mainWindow: BrowserWindow | null = null;

const MAIN_WINDOW_VITE_DEV_SERVER_URL = process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL;
const MAIN_WINDOW_VITE_NAME = process.env.MAIN_WINDOW_VITE_NAME;

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
		return;
	}

	mainWindow.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
};
