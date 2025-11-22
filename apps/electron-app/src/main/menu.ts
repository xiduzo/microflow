import { app, BrowserWindow, Menu, MenuItem, MenuItemConstructorOptions } from 'electron';
import { importFlow } from './file';
import { IpcResponse } from '../common/types';

const isMac = process.platform === 'darwin';

const isDevelopment = !app.isPackaged;

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
					isMac ? { role: 'close' } : {},
				],
			},
		]
	: [];

type MenuResponse = IpcResponse<{ button: string; args?: any }>;
export function createMenu(mainWindow: BrowserWindow, createWindow: () => Promise<void>) {
	const menuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [
		...appMenu,
		{
			label: 'Flow',
			submenu: [
				{
					label: 'Add node',
					accelerator: isMac ? 'Cmd+K' : 'Ctrl+K',
					click: () => sendMessage(mainWindow, 'add-node'),
				},
				{ type: 'separator' },
				{
					label: 'New flow',
					accelerator: isMac ? 'Cmd+N' : 'Ctrl+N',
					click: () => sendMessage(mainWindow, 'new-flow'),
				},
				{
					label: 'Save flow',
					accelerator: isMac ? 'Cmd+S' : 'Ctrl+S',
					click: () => sendMessage(mainWindow, 'export-flow'),
				},
				{
					label: 'Import flow',
					accelerator: isMac ? 'Cmd+I' : 'Ctrl+I',
					click: async () => {
						const flow = await importFlow();
						if (!flow) return;

						sendMessage(mainWindow, 'import-flow', flow);
					},
				},
				{ type: 'separator' },
				{
					label: 'Fit flow in view',
					accelerator: isMac ? 'Cmd+O' : 'Ctrl+O',
					click: () => sendMessage(mainWindow, 'fit-flow'),
				},
				{ type: 'separator' },
				{
					label: 'Edit',
					submenu: [
						{
							label: 'Undo',
							accelerator: isMac ? 'Cmd+Z' : 'Ctrl+Z',
							click: () => {
								mainWindow.webContents.undo();
								sendMessage(mainWindow, 'undo');
							},
						},
						{
							label: 'Redo',
							accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Shift+Z',
							click: () => {
								mainWindow.webContents.redo();
								sendMessage(mainWindow, 'redo');
							},
						},
						{ type: 'separator' },
						{
							label: 'Cut',
							accelerator: isMac ? 'Cmd+X' : 'Ctrl+X',
							click: () => {
								mainWindow.webContents.cut();
								sendMessage(mainWindow, 'cut');
							},
						},
						{
							label: 'Copy',
							accelerator: isMac ? 'Cmd+C' : 'Ctrl+C',
							click: () => {
								mainWindow.webContents.copy();
								sendMessage(mainWindow, 'copy');
							},
						},
						{
							label: 'Paste',
							accelerator: isMac ? 'Cmd+V' : 'Ctrl+V',
							click: () => {
								mainWindow.webContents.paste();
								sendMessage(mainWindow, 'paste');
							},
						},
						{ type: 'separator' },
						{
							label: 'Select all',
							accelerator: isMac ? 'Cmd+A' : 'Ctrl+A',
							click: () => {
								mainWindow.webContents.selectAll();
								sendMessage(mainWindow, 'select-all');
							},
						},
						{
							label: 'Deselect all',
							accelerator: 'Escape',
							click: () => {
								sendMessage(mainWindow, 'deselect-all');
							},
						},
						{ type: 'separator' },
						{
							label: 'Delete',
							accelerator: isMac ? 'Backspace' : 'Backspace',
							click: () => {
								mainWindow.webContents.delete();
								sendMessage(mainWindow, 'delete');
							},
						},
					],
				},
			],
		},
		{
			label: 'Settings',
			submenu: [
				{
					label: 'User settings',
					click: () => sendMessage(mainWindow, 'user-settings'),
				},
				{
					label: 'MQTT settings',
					click: () => sendMessage(mainWindow, 'mqtt-settings'),
				},
				{
					label: 'Microcontroller settings',
					click: () => sendMessage(mainWindow, 'board-settings'),
				},
			],
		},
		// Development-only menu
		...(isDevelopment
			? [
					{
						label: 'Development',
						submenu: [
							{
								label: 'New Window',
								accelerator: isMac ? 'Cmd+Shift+N' : 'Ctrl+Shift+N',
								click: () => {
									createWindow();
								},
							},
						],
					},
				]
			: []),
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

function sendMessage(mainWindow: BrowserWindow, button: string, args?: any) {
	mainWindow.webContents.send('ipc-menu', {
		success: true,
		data: { button, args },
	} satisfies MenuResponse);
}
