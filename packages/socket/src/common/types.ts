export type Connection = { id: string; name: string };

export type ClientIdentifyMessage = { type: 'identify'; data: { name: string } };
export type ServerIdentifyMessage = {
	type: 'identify';
	data: { user: Connection; connections: Connection[] };
};

export type ClientMouseMessage = { type: 'mouse'; data: { x: number; y: number } };
export type ServerMouseMessage = {
	type: 'mouse';
	data: { x: number; y: number; user: Connection };
};

// Node operation messages
export type ClientNodeAddMessage = { type: 'node-add'; data: { node: unknown } };
export type ClientNodeRemoveMessage = { type: 'node-remove'; data: { nodeId: string } };
export type ClientNodePositionMessage = {
	type: 'node-position';
	data: { nodeId: string; position: { x: number; y: number } };
};
export type ClientNodeDataMessage = { type: 'node-data'; data: { nodeId: string; data: unknown } };

export type ClientEdgeRemoveMessage = { type: 'edge-remove'; data: { edgeId: string } };
export type ClientEdgeAddMessage = { type: 'edge-add'; data: { edge: unknown } };

export type ServerNodeAddMessage = { type: 'node-add'; data: { node: unknown } };
export type ServerNodeRemoveMessage = { type: 'node-remove'; data: { nodeId: string } };
export type ServerNodePositionMessage = {
	type: 'node-position';
	data: { nodeId: string; position: { x: number; y: number } };
};
export type ServerNodeDataMessage = { type: 'node-data'; data: { nodeId: string; data: unknown } };
export type ServerEdgeRemoveMessage = { type: 'edge-remove'; data: { edgeId: string } };
export type ServerEdgeAddMessage = { type: 'edge-add'; data: { edge: unknown } };

export type ServerConnectedMessage = {
	type: 'connected';
	data: { user: Connection; connections: Connection[] };
};
export type ServerDisconnectedMessage = {
	type: 'disconnected';
	data: { user: Connection; connections: Connection[] };
};

export type ClientMessage =
	| ClientIdentifyMessage
	| ClientMouseMessage
	| ClientNodeAddMessage
	| ClientNodeRemoveMessage
	| ClientNodePositionMessage
	| ClientNodeDataMessage
	| ClientEdgeRemoveMessage
	| ClientEdgeAddMessage;
export type ServerMessage =
	| ServerIdentifyMessage
	| ServerMouseMessage
	| ServerNodeAddMessage
	| ServerNodeRemoveMessage
	| ServerNodePositionMessage
	| ServerNodeDataMessage
	| ServerConnectedMessage
	| ServerDisconnectedMessage
	| ServerEdgeRemoveMessage
	| ServerEdgeAddMessage;
