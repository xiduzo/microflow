import type { Edge, Node } from '@xyflow/react';

// https://github.com/firmata/protocol/blob/master/protocol.md#supported-modes
// https://johnny-five.io/api/pin/#modes
export enum MODES {
	INPUT = 0,
	OUTPUT = 1,
	ANALOG = 2,
	PWM = 3,
	SERVO = 4,
	SHIFT = 5,
	I2C = 6,
	ONEWIRE = 7,
	STEPPER = 8,
	ENCODER = 9,
	SERIAL = 10,
	PULLUP = 11,
	SPI = 12,
	SONAR = 13,
	TONE = 14,
	DHT = 15,
	IGNORE = 127,
	PING_READ = 117,
	UNKOWN = 16,
}

export const PIN_MODES = new Map<MODES, string>([
	[MODES.INPUT, 'input'],
	[MODES.OUTPUT, 'output'],
	[MODES.ANALOG, 'analog'],
	[MODES.PWM, 'pwm'],
	[MODES.SERVO, 'servo'],
	[MODES.SHIFT, 'shift'],
	[MODES.I2C, 'i2c'],
	[MODES.ONEWIRE, 'onewire'],
	[MODES.STEPPER, 'stepper'],
	[MODES.SERIAL, 'serial'],
	[MODES.PULLUP, 'pullup'],
	[MODES.SPI, 'spi'],
	[MODES.SONAR, 'sonar'],
	[MODES.TONE, 'tone'],
	[MODES.DHT, 'dht'],
	[MODES.IGNORE, 'ignore'],
	[MODES.PING_READ, 'ping_read'],
	[MODES.UNKOWN, 'unkown'],
]);

export type Pin = {
	supportedModes: MODES[];
	analogChannel: number;
	mode?: unknown;
	pin: number;
};

export type BoardCheckResult = {
	type: 'info' | 'ready' | 'fail' | 'warn' | 'exit' | 'close' | 'error' | 'connect';
	message?: string;
	port?: string;
};

export type BoardFlashResult = {
	type: 'done' | 'error' | 'flashing';
	message?: string;
};

export type UploadRequest = {
	port: string;
	nodes: Pick<Node, 'data' | 'id' | 'type'>[];
	edges: Omit<Edge, 'id'>[];
};

export type UploadResponse = {
	type: 'info' | 'ready' | 'fail' | 'warn' | 'exit' | 'close' | 'error';
	message?: string;
	pins?: Pin[];
};

export type UploadedCodeMessage = {
	nodeId: string;
	action: string;
	value?: unknown;
};

export type FlowFile = {
	nodes: Node[];
	edges: Edge[];
};

export type IpcResponse<T> = { success: true; data: T } | { success: false; error: string };
