import { app, BrowserWindow, Menu, MenuItem, MenuItemConstructorOptions } from 'electron';
import { importFlow } from './file';

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
					isMac ? { role: 'close' } : undefined,
				],
			},
		]
	: [];

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
						mainWindow.webContents.send('ipc-menu', 'add-node');
					},
				},
				{ type: 'separator' },
				{
				  label: 'Undo',
          accelerator: isMac ? 'Cmd+Z' : 'Ctrl+Z',
          click: () => {
            mainWindow.webContents.send('ipc-menu', 'undo');
          }
				},
				{
				  label: 'Redo',
          accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Shift+Z',
          click: () => {
            mainWindow.webContents.send('ipc-menu', 'redo');
          }
				},
				{ type: 'separator' },
				{
					label: 'Save flow',
					accelerator: isMac ? 'Cmd+S' : 'Ctrl+S',
					click: () => {
						mainWindow.webContents.send('ipc-menu', 'save-flow');
					},
				},
				{
					id: 'autosave',
					label: 'Auto save',
					type: 'checkbox',
					checked: true,
					click: menuItem => {
						mainWindow.webContents.send('ipc-menu', 'toggle-autosave', menuItem.checked);
					},
				},
				{ type: 'separator' },
				{
					label: 'New flow',
					accelerator: isMac ? 'Cmd+N' : 'Ctrl+N',
					click: () => {
						mainWindow.webContents.send('ipc-menu', 'new-flow');
					},
				},
				{
				  label: 'Export flow',
          accelerator: isMac ? 'Cmd+E' : 'Ctrl+E',
          click: () => {
            mainWindow.webContents.send('ipc-menu', 'export-flow');
          }
				},
				{
				  label: 'Import flow',
          accelerator: isMac ? 'Cmd+I' : 'Ctrl+I',
          click: async () => {
            const flow = await importFlow()
            if(!flow) return

            mainWindow.webContents.send('ipc-menu', 'import-flow', flow);
          }
				}
			],
		},
		{
			label: 'Settings',
			submenu: [
				{
					label: 'MQTT settings',
					click: () => {
						mainWindow.webContents.send('ipc-menu', 'mqtt-settings');
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
