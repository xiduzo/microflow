import { Edge, Node } from '@xyflow/react';

export const INTRODUCTION_NODES = [
	{
		data: {
			group: 'flow',
			tags: ['event', 'generator'],
			label: 'Interval',
			icon: 'TimerIcon',
			autoStart: true,
			interval: 1000,
			description: 'Automatically send a signal at regular time intervals, like a timer',
		},
		id: 'plqmjyhgmeus',
		type: 'Interval',
		position: {
			x: 1554.5641873312247,
			y: 312.4588182914703,
		},
		measured: {
			width: 320,
			height: 224,
		},
		selected: false,
		dragging: false,
	},
	{
		data: {
			group: 'flow',
			tags: ['information'],
			label: 'Click me!',
			icon: 'NotebookIcon',
			note: 'Welcome to microflow studio 👋',
			extraInfo: 'Oh hi there explorer, connect your microcontroller to get started.',
			description: 'Add text notes to your flow to document what different parts do',
		},
		id: 'wqbrcpaydjxd',
		type: 'Note',
		position: {
			x: 1931.382651113286,
			y: 283.4243059473913,
		},
		measured: {
			width: 320,
			height: 224,
		},
		selected: false,
		dragging: false,
	},
	{
		data: {
			group: 'hardware',
			tags: ['output', 'analog', 'digital'],
			label: 'LED',
			icon: 'LightbulbIcon',
			pin: 13,
			description: 'Turn a light on or off, or control its brightness',
		},
		id: 'uyvsdiyfuoiv',
		type: 'Led',
		position: {
			x: 1934.9452913398104,
			y: 537.8864281667335,
		},
		measured: {
			width: 320,
			height: 244,
		},
		selected: false,
		dragging: false,
	},
] satisfies Node[];

export const INTRODUCTION_EDGES = [
	{
		source: 'plqmjyhgmeus',
		sourceHandle: 'change',
		target: 'uyvsdiyfuoiv',
		targetHandle: 'toggle',
		id: 'sfgswxqpqsyt',
		type: 'animated',
	},
] satisfies Edge[];
