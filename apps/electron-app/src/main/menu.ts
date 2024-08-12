import {
	app,
	BrowserWindow,
	Menu,
	MenuItem,
	MenuItemConstructorOptions,
} from 'electron';

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
						mainWindow.webContents.send(
							'ipc-menu',
							'toggle-autosave',
							menuItem.checked,
						);
					},
				},
				{
					label: 'Clear flow',
					click: () => {
						mainWindow.webContents.send('ipc-menu', 'clear-flow');
					},
				},
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
