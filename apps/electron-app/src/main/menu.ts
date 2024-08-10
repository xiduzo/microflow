import { app, Menu, MenuItem, MenuItemConstructorOptions } from 'electron';

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
				],
			},
		]
	: [];

const menuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [
	...appMenu,
	{
		label: 'File',
		submenu: [
			{
				label: 'Save flow',
			},
			{
				label: 'Auto save',
				checked: true,
			},
			{ type: 'separator' },
			{
				label: 'Export',
			},
			{
				label: 'Import',
			},
			isMac ? { role: 'close' } : { role: 'quit' },
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
