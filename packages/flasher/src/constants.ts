import { Stk500v1 } from './protocols/Stk500v1';

export const BOARDS = [
	{
		name: 'nano',
		baudRate: 57600,
		signature: Buffer.from([0x1e, 0x95, 0x0f]),
		pageSize: 128,
		numPages: 256,
		timeout: 400,
		productId: ['6001', '7523'],
		productPage:
			'https://web.archive.org/web/20150813095112/https://www.arduino.cc/en/Main/ArduinoBoardNano',
		protocol: Stk500v1,
	},
	{
		name: 'nano (new bootloader)',
		baudRate: 115200,
		signature: Buffer.from([0x1e, 0x95, 0x0f]),
		pageSize: 128,
		numPages: 256,
		timeout: 400,
		productId: ['6001', '7523'],
		productPage: 'https://store.arduino.cc/arduino-nano',
		protocol: Stk500v1,
	},
] as const;

export type Board = (typeof BOARDS)[number];
export type BoardName = Board['name'];
