import { Edge, Node } from '@xyflow/react';

export const INTRODUCTION_NODES = [
	{
		data: {
			group: 'flow',
			tags: ['information'],
			label: 'Click me!',
			note: 'Welcome to microflow studio!',
			extraInfo: 'Oh hi there explorer, connect your microcontroller to get started.',
		},
		id: '3ee5ir',
		type: 'Note',
		position: { x: 400, y: 221 },
		measured: { width: 256, height: 176 },
	},
	{
		data: {
			group: 'flow',
			tags: ['event'],
			label: 'Interval',
			interval: 1000,
		},
		id: 'th0fbh',
		type: 'Interval',
		position: { x: 86, y: 252 },
		measured: { width: 208, height: 176 },
	},
	{
		data: {
			group: 'hardware',
			tags: ['output', 'analog', 'digital'],
			label: 'LED',
			pin: 13,
		},
		id: 'l9919g',
		type: 'Led',
		position: { x: 425, y: 504 },
		measured: { width: 208, height: 176 },
	},
] satisfies Node[];

export const INTRODUCTION_EDGES = [
	{
		source: 'th0fbh',
		sourceHandle: 'change',
		target: 'l9919g',
		targetHandle: 'toggle',
		id: 'xy-edge__th0fbhchange-l9919gtoggle',
	},
] satisfies Edge[];
