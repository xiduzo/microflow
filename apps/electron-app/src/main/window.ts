import { app, BrowserWindow } from 'electron/main';
import { IpcResponse } from '../common/types';
import { type Channels } from '../preload';
import { handleDeepLink } from './deepLink';
import path from 'node:path';

export const windows: BrowserWindow[] = [];

export let mainWindow: BrowserWindow | null = null;
export let mainWindowReady = false;

export function sendMessageToRenderer<T>(channel: Channels, data: IpcResponse<T>) {
	mainWindow?.webContents.send(channel, data);
}

export function addWindow(window: BrowserWindow) {
	windows.push(window);
	if (!mainWindow) {
		mainWindow = window;
		window.webContents.on('did-finish-load', () => {
			mainWindowReady = true;
		});
	}
}

export function removeWindow(window: BrowserWindow) {
	const index = windows.indexOf(window);
	if (index > -1) {
		windows.splice(index, 1);
	}
	if (mainWindow === window) {
		mainWindow = windows.length > 0 ? windows[0] : null;
	}
}

export function handleSecondInstance(commandLine: string[]) {
	// Someone tried to run a second instance, we should focus our window.
	if (mainWindow) {
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	}

	recreateWindowWhenNeeded().then(() => {
		handleDeepLink(mainWindow!, commandLine.pop()?.slice(0, -1) ?? '');
	});
}

export async function recreateWindowWhenNeeded() {
	if (windows.length === 0) {
		await createWindow();
		await new Promise(resolve => setTimeout(resolve, 1000));
	}

	return Promise.resolve();
}

// Check if we're in development mode
const isDevelopment = !!app.isPackaged;

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

	addWindow(window);

	if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
		await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
		window.webContents.openDevTools();
	} else {
		await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
	}

	window.on('closed', () => removeWindow(window));

	return window;
}
