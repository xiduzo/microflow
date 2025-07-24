import { Socket, Server } from 'socket.io';
import log from 'electron-log/node';
import { ClientMessage, Connection, ServerMessage } from '../common/types';

const connectedClients = new Map<string, Connection>();

export function handleSocket(socket: Socket, server: Server) {
	log.debug('[SOCKET] <connection>', socket.id);
	connectedClients.set(socket.id, { id: socket.id, name: 'unknown' });

	// Add error handler for the socket
	socket.on('error', (error) => {
		log.error('[SOCKET] <socket error>', socket.id, error);
	});

	socket.on('message', (message: ClientMessage) => {
		try {
			let parsedMessage = message;
			if (typeof message === 'string') {
				try {
					// Attempt to parse the message as JSON
					parsedMessage = JSON.parse(message) as ClientMessage;
				} catch (error) {
					log.error('[SOCKET] <parse error>', message, error);
					return;
				}
			}
			log.debug(`[SOCKET] <message> by ${socket.id}`, parsedMessage, typeof parsedMessage);

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
					if (!user) {
						log.debug('[SOCKET] <mouse> <no user found>', socket.id);
						return;
					}
					const mouseMessage = {
						type: 'mouse',
						data: { x: parsedMessage.data.x, y: parsedMessage.data.y, user },
					} satisfies ServerMessage;
					log.debug('[SOCKET] <broadcasting mouse>', mouseMessage);
					server.emit(parsedMessage.type, mouseMessage);
					break;
				default:
					log.warn('[SOCKET] <unknown message type>', parsedMessage);
					break;
			}
		} catch (error) {
			log.error('[SOCKET] <message handler error>', error);
		}
	});

	// Handle disconnection
	socket.on('disconnect', () => {
		log.debug('[SOCKET] <disconnect>', socket.id);
		connectedClients.delete(socket.id);
	});
}
