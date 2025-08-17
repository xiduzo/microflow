import { Edge, Node } from '@xyflow/react';

const InformationNode: Node = {
	data: {
		group: 'flow',
		tags: ['information'],
		label: 'Click me!',
		note: 'Welcome to microflow studio!',
		extraInfo: 'Oh hi there explorer, connect your microcontroller to get started.',
	},
	id: crypto.randomUUID(),
	type: 'Note',
	position: { x: 400, y: 221 },
	measured: { width: 256, height: 176 },
};

const IntervalNode: Node = {
	data: {
		group: 'flow',
		tags: ['event'],
		label: 'Interval',
		interval: 1000,
	},
	id: crypto.randomUUID(),
	type: 'Interval',
	position: { x: 86, y: 252 },
	measured: { width: 208, height: 176 },
};

const LedNode: Node = {
	data: {
		group: 'hardware',
		tags: ['output', 'analog', 'digital'],
		label: 'LED',
		pin: 13,
	},
	id: crypto.randomUUID(),
	type: 'Led',
	position: { x: 425, y: 504 },
	measured: { width: 208, height: 176 },
};

export const INTRODUCTION_NODES = [InformationNode, IntervalNode, LedNode] satisfies Node[];

const IntervalToLedEdge: Edge = {
	source: IntervalNode.id,
	sourceHandle: 'change',
	target: LedNode.id,
	targetHandle: 'toggle',
	id: crypto.randomUUID(),
};

export const INTRODUCTION_EDGES = [IntervalToLedEdge] satisfies Edge[];
