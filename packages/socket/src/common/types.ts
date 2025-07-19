export type Connection = { id: string; name: string };

export type ClientIdentifyMessage = { type: 'identify'; data: { name: string } };
type ServerIdentifyMessage = { type: 'identify'; data: { connections: Connection[] } };

export type ClientMessage = ClientIdentifyMessage;
export type ServerMessage = ServerIdentifyMessage;
