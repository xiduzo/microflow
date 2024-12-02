import { app, BrowserWindow, Menu, MenuItem, MenuItemConstructorOptions } from 'electron';
import { importFlow } from './file';
import { IpcResponse } from '../common/types';

const isMac = process.platform === 'darwin';

const appMenu: (MenuItemConstructorOptions | MenuItem)[] = isMac
	? [
			{
				label: app.name,
				submenu: [
					{ role: 'about' },
					{ type: 'separator' },
					// { role: 'services' },
					// { type: 'separator' },
					{ role: 'hide' },
					{ role: 'hideOthers' },
					{ role: 'unhide' },
					{ type: 'separator' },
					{ role: 'quit' },
					{ role: 'editMenu' },
					isMac ? { role: 'close' } : {},
				],
			},
		]
	: [];

type MenuResponse = IpcResponse<{ button: string; args?: any }>;
export function createMenu(mainWindow: BrowserWindow) {
	const menuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [
		...appMenu,
		{
			label: 'Flow',
			submenu: [
				{
					label: 'Insert node',
					accelerator: isMac ? 'Cmd+K' : 'Ctrl+K',
					click: () => {
						mainWindow.webContents.send('ipc-menu', {
							success: true,
							data: { button: 'add-node' },
						} satisfies MenuResponse);
					},
				},
				{ type: 'separator' },
				{
					label: 'Undo',
					accelerator: isMac ? 'Cmd+U' : 'Ctrl+U',
					click: () => {
						mainWindow.webContents.send('ipc-menu', {
							success: true,
							data: { button: 'undo' },
						} satisfies MenuResponse);
					},
				},
				{
					label: 'Redo',
					accelerator: isMac ? 'Cmd+Shift+U' : 'Ctrl+Shift+U',
					click: () => {
						mainWindow.webContents.send('ipc-menu', {
							success: true,
							data: { button: 'redo' },
						} satisfies MenuResponse);
					},
				},
				{ type: 'separator' },
				{
					label: 'Save flow',
					accelerator: isMac ? 'Cmd+S' : 'Ctrl+S',
					click: () => {
						mainWindow.webContents.send('ipc-menu', {
							success: true,
							data: { button: 'save-flow' },
						} satisfies MenuResponse);
					},
				},
				{
					id: 'autosave',
					label: 'Auto save',
					type: 'checkbox',
					checked: true,
					click: menuItem => {
						mainWindow.webContents.send('ipc-menu', {
							success: true,
							data: { button: 'toggle-autosave', args: menuItem.checked },
						} satisfies MenuResponse);
					},
				},
				{ type: 'separator' },
				{
					label: 'New flow',
					accelerator: isMac ? 'Cmd+N' : 'Ctrl+N',
					click: () => {
						mainWindow.webContents.send('ipc-menu', {
							success: true,
							data: { button: 'new-flow' },
						} satisfies MenuResponse);
					},
				},
				{
					label: 'Export flow',
					accelerator: isMac ? 'Cmd+E' : 'Ctrl+E',
					click: () => {
						mainWindow.webContents.send('ipc-menu', {
							success: true,
							data: { button: 'export-flow' },
						} satisfies MenuResponse);
					},
				},
				{
					label: 'Import flow',
					accelerator: isMac ? 'Cmd+I' : 'Ctrl+I',
					click: async () => {
						const flow = await importFlow();
						if (!flow) return;

						mainWindow.webContents.send('ipc-menu', {
							success: true,
							data: { button: 'import-flow', args: flow },
						} satisfies MenuResponse);
					},
				},
			],
		},
		{
			label: 'Settings',
			submenu: [
				{
					label: 'Microcontroller settings',
					click: () => {
						mainWindow.webContents.send('ipc-menu', {
							success: true,
							data: { button: 'board-settings' },
						} satisfies MenuResponse);
					},
				},
				{
					label: 'MQTT settings',
					click: () => {
						mainWindow.webContents.send('ipc-menu', {
							success: true,
							data: { button: 'mqtt-settings' },
						} satisfies MenuResponse);
					},
				},
			],
		},
		{ role: 'viewMenu' },
		{ role: 'windowMenu' },
		{
			role: 'help',
			submenu: [
				{
					label: 'Learn More',
					click: async () => {
						const { shell } = require('electron');
						await shell.openExternal('https://microflow.vercel.app/');
					},
				},
			],
		},
	];

	const menu = Menu.buildFromTemplate(menuTemplate);
	Menu.setApplicationMenu(menu);
}
