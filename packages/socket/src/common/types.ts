export type Connection = { id: string; name: string };

export type ClientIdentifyMessage = { type: 'identify'; data: { name: string } };
type ServerIdentifyMessage = { type: 'identify'; data: { connections: Connection[] } };

export type ClientMouseMessage = { type: 'mouse'; data: { x: number; y: number } };
type ServerMouseMessage = { type: 'mouse'; data: { x: number; y: number; user: Connection } };

export type ClientMessage = ClientIdentifyMessage | ClientMouseMessage;
export type ServerMessage = ServerIdentifyMessage | ServerMouseMessage;
