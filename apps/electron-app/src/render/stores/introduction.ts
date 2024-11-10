import { Edge, Node } from '@xyflow/react';

export const INTRODUCTION_NODES = [
	{
		data: {
			label: 'Note',
			value: 'Welcome to microflow studio!',
			extraInfo: '',
			settingsOpen: false,
		},
		id: 'i9bg0b',
		type: 'Note',
		position: { x: 403, y: 207 },
		selected: false,
		measured: { width: 256, height: 176 },
		dragging: false,
	},
	{
		data: { label: 'Interval', interval: 500, settingsOpen: false },
		id: '57ntop',
		type: 'Interval',
		position: { x: 147, y: 208 },
		selected: false,
		measured: { width: 208, height: 176 },
		dragging: false,
	},
	{
		data: { label: 'LED', pin: 13, settingsOpen: false },
		id: '1m3xsm',
		type: 'Led',
		position: { x: 425, y: 464 },
		selected: false,
		measured: { width: 208, height: 176 },
		dragging: false,
	},
] satisfies Node[];

export const INTRODUCTION_EDGES = [
	{
		source: '57ntop',
		sourceHandle: 'change',
		target: '1m3xsm',
		targetHandle: 'toggle',
		id: 'xy-edge__57ntopchange-1m3xsmtoggle',
		animated: false,
		selected: false,
	},
] satisfies Edge[];
