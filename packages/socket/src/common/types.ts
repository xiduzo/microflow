import type {
	EdgeAddChange,
	EdgeRemoveChange,
	NodeAddChange,
	NodeRemoveChange,
	NodePositionChange,
	NodeReplaceChange,
} from '@xyflow/system';

export type Connection = { id: string; name: string };

export type ClientIdentifyMessage = { type: 'identify'; data: { name: string } };
export type ServerIdentifyMessage = {
	type: 'identify';
	data: { user: Connection; connections: Connection[] };
};

export type ClientCursorMessage = {
	type: 'cursor';
	data: { change: Omit<NodePositionChange, 'id'> };
};
export type ServerCursorMessage = {
	type: 'cursor';
	data: { change: NodePositionChange };
};

// Node operation messages
export type NodeAddMessage = { type: 'node-add'; data: { change: NodeAddChange } };
export type NodeRemoveMessage = { type: 'node-remove'; data: { change: NodeRemoveChange } };
export type NodePositionMessage = { type: 'node-position'; data: { change: NodePositionChange } };
export type NodeDataMessage = { type: 'node-data'; data: { change: NodeReplaceChange } };

export type EdgeRemoveMessage = { type: 'edge-remove'; data: { change: EdgeRemoveChange } };
export type EdgeAddMessage = { type: 'edge-add'; data: { change: EdgeAddChange } };

export type ConnectedMessage = {
	type: 'connected';
	data: { user: Connection; connections: Connection[] };
};
export type DisconnectedMessage = {
	type: 'disconnected';
	data: { user: Connection; connections: Connection[] };
};

export type XyFlowMessage =
	| NodeAddMessage
	| NodeRemoveMessage
	| NodePositionMessage
	| NodeDataMessage
	| EdgeAddMessage
	| EdgeRemoveMessage;

export type ClientMessage = ClientIdentifyMessage | ClientCursorMessage | XyFlowMessage;
export type ServerMessage =
	| ServerIdentifyMessage
	| ConnectedMessage
	| DisconnectedMessage
	| XyFlowMessage
	| ServerCursorMessage;
