export type Connection = { id: string; name: string };

export type ClientIdentifyMessage = { type: 'identify'; data: { name: string } };
export type ServerIdentifyMessage = { type: 'identify'; data: { user: Connection; connections: Connection[] } };

export type ClientMouseMessage = { type: 'mouse'; data: { x: number; y: number } };
export type ServerMouseMessage = { type: 'mouse'; data: { x: number; y: number; user: Connection } };

export type ServerConnectedMessage = { type: 'connected', data: { user: Connection; connections: Connection[] } };
export type ServerDisconnectedMessage = { type: 'disconnected', data: { user: Connection; connections: Connection[] } };

export type ClientMessage = ClientIdentifyMessage | ClientMouseMessage;
export type ServerMessage = ServerIdentifyMessage | ServerMouseMessage | ServerConnectedMessage | ServerDisconnectedMessage;
