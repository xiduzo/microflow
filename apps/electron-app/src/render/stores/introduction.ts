import { Edge, Node } from '@xyflow/react';

export const INTRODUCTION_NODES = [
	{
		data: {
			group: 'flow',
			tags: ['information'],
			label: 'Note',
			note: 'Welcome to microflow studio!',
			extraInfo: 'Oh hi there explorer, hope you found what you were looking for.',
			settingsOpen: false,
		},
		id: '3ee5ir',
		type: 'Note',
		position: { x: 400, y: 221 },
		selected: false,
		measured: { width: 256, height: 176 },
		dragging: false,
	},
	{
		data: {
			group: 'flow',
			tags: ['event'],
			label: 'Interval',
			interval: 1000,
			settingsOpen: false,
		},
		id: 'th0fbh',
		type: 'Interval',
		position: { x: 86, y: 252 },
		selected: false,
		measured: { width: 208, height: 176 },
		dragging: false,
	},
	{
		data: {
			group: 'hardware',
			tags: ['output', 'analog', 'digital'],
			label: 'LED',
			pin: 13,
			settingsOpen: false,
		},
		id: 'l9919g',
		type: 'Led',
		position: { x: 425, y: 504 },
		selected: false,
		measured: { width: 208, height: 176 },
		dragging: false,
	},
] satisfies Node[];

export const INTRODUCTION_EDGES = [
	{
		source: 'th0fbh',
		sourceHandle: 'change',
		target: 'l9919g',
		targetHandle: 'toggle',
		id: 'xy-edge__th0fbhchange-l9919gtoggle',
		animated: false,
		selected: false,
	},
] satisfies Edge[];
