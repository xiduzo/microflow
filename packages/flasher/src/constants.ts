import { Avr109 } from './protocols/Avr109';
import { Stk500v1 } from './protocols/Stk500v1';
// import { Stk500v2 } from './protocols/Stk500v2';

export const BOARDS = [
	{
		name: 'uno',
		baudRate: 115200,
		signature: Buffer.from([0x1e, 0x95, 0x0f]),
		pageSize: 128,
		numPages: 256,
		timeout: 400,
		productIds: ['0043', '7523', '0001', 'ea60', '6015'],
		productPage: 'https://store.arduino.cc/arduino-uno-rev3',
		protocol: Stk500v1,
	},
	{
		name: 'nano',
		baudRate: 57600,
		signature: Buffer.from([0x1e, 0x95, 0x0f]),
		pageSize: 128,
		numPages: 256,
		timeout: 400,
		productIds: ['6001', '7523'],
		productPage:
			'https://web.archive.org/web/20150813095112/https://www.arduino.cc/en/Main/ArduinoBoardNano',
		protocol: Stk500v1,
	},
	// {
	// 	name: 'mega',
	// 	baudRate: 115200,
	// 	signature: Buffer.from([0x1e, 0x98, 0x01]), // ATmega2560
	// 	pageSize: 256,
	// 	delay1: 10,
	// 	delay2: 1,
	// 	timeout: 0xc8,
	// 	stabDelay: 0x64,
	// 	cmdexeDelay: 0x19,
	// 	synchLoops: 0x20,
	// 	byteDelay: 0x00,
	// 	pollValue: 0x53,
	// 	pollIndex: 0x03,
	// 	productIds: ['0042', '6001', '0010', '7523'],
	// 	productPage: 'https://store.arduino.cc/mega-2560-r3',
	// 	protocol: Stk500v2,
	// },
	{
		name: 'nano (new bootloader)',
		baudRate: 115200,
		signature: Buffer.from([0x1e, 0x95, 0x0f]),
		pageSize: 128,
		numPages: 256,
		timeout: 400,
		productIds: ['6001', '7523'],
		productPage: 'https://store.arduino.cc/arduino-nano',
		protocol: Stk500v1,
	},
	{
		name: 'leonardo',
		baudRate: 57600,
		signature: Buffer.from([0x43, 0x41, 0x54, 0x45, 0x52, 0x49, 0x4e]),
		productIds: ['0036', '8036', '800c'],
		productPage: 'https://store.arduino.cc/leonardo',
		protocol: Avr109,
	},
	{
		name: 'micro',
		baudRate: 57600,
		signature: Buffer.from([0x43, 0x41, 0x54, 0x45, 0x52, 0x49, 0x4e]),
		productIds: ['0037', '8037', '0036', '0237'],
		productPage: 'https://store.arduino.cc/arduino-micro',
		protocol: Avr109,
	},
	{
		name: 'yun',
		baudRate: 57600,
		signature: Buffer.from([0x43, 0x41, 0x54, 0x45, 0x52, 0x49, 0x4e]),
		productIds: ['0041', '8041'],
		productPage: 'https://store.arduino.cc/arduino-yun',
		protocol: Avr109,
	},
] as const;

export type Board = (typeof BOARDS)[number];
export type BoardName = Board['name'];
export type BoardProductId = Board['productIds'][number];
