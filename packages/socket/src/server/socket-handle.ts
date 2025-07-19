import { Socket, Server } from 'socket.io';
import { ClientMessage, Connection, ServerMessage } from '../common/types';

const connectedClients = new Map<string, Connection>();

export function handleSocket(socket: Socket, server: Server) {
	console.debug('[SOCKET] <connection>', socket.id);
	connectedClients.set(socket.id, { id: socket.id, name: 'unknown' });

	socket.on('message', (message: ClientMessage) => {
		let parsedMessage = message;
		if (typeof message === 'string') {
			try {
				// Attempt to parse the message as JSON
				parsedMessage = JSON.parse(message) as ClientMessage;
			} catch (error) {
				console.error('[SOCKET] <parse error>', message, error);
			}
		}
		console.debug(`<<<< [SOCKET] <message> by ${socket.id}`, parsedMessage, typeof parsedMessage);

		switch (parsedMessage.type) {
			case 'identify':
				connectedClients.set(socket.id, { id: socket.id, name: parsedMessage.data.name });
				server.emit(parsedMessage.type, {
					type: 'identify',
					data: { connections: Array.from(connectedClients.values()) },
				} satisfies ServerMessage);
				break;
			case 'mouse':
				const user = connectedClients.get(socket.id);
				if (!user) return console.debug('[SOCKET] <mouse> <no user found>', socket.id);
				server.emit(parsedMessage.type, {
					type: 'mouse',
					data: { x: parsedMessage.data.x, y: parsedMessage.data.y, user },
				} satisfies ServerMessage);
				break;
			default:
				console.warn('[SOCKET] <unknown message type>', parsedMessage);
				break;
		}
	});

	// Handle disconnection
	socket.on('disconnect', () => {
		console.debug('[SOCKET] <disconnect>', socket.id);
		connectedClients.delete(socket.id);
	});
}
