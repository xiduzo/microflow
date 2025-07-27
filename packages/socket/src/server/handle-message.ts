import { Server, Socket } from 'socket.io';
import {
	ClientMessage,
	Connection,
	ServerEdgeAddMessage,
	ServerEdgeRemoveMessage,
	ServerIdentifyMessage,
	ServerMessage,
	ServerMouseMessage,
	ServerNodeAddMessage,
	ServerNodeDataMessage,
	ServerNodePositionMessage,
	ServerNodeRemoveMessage,
} from '../common/types';
import log from 'electron-log/node';

function parseMessage<T>(message: T): T {
	if (typeof message === 'string') {
		try {
			return JSON.parse(message) as T;
		} catch (error) {
			log.error('[SOCKET] <parse error>', message, error);
			return message as T;
		}
	}
	return message as T;
}

export function handleSocket(
	socket: Socket,
	server: Server,
	connectedClients: Map<string, Connection>
) {
	log.debug('[SOCKET] <connection>', socket.id);
	connectedClients.set(socket.id, { id: socket.id, name: 'unknown' });
	const connection = connectedClients.get(socket.id);
	socket.emit('connected', {
		type: 'connected',
		data: {
			user: connection!,
			connections: Array.from(connectedClients.values()),
		},
	} satisfies ServerMessage);

	// Add error handler for the socket
	socket.on('error', error => {
		log.error('[SOCKET] <socket error>', socket.id, error);
	});

	socket.on('message', (message: ClientMessage, ack?: (val: string) => void) => {
		ack?.('ACK');
		const parsedMessage = parseMessage(message);
		log.debug(`[SOCKET] <message> by ${socket.id}`, parsedMessage, typeof parsedMessage);

		switch (parsedMessage.type) {
			case 'identify':
				connectedClients.set(socket.id, {
					id: socket.id,
					name: parsedMessage.data.name,
				});
				const connection = connectedClients.get(socket.id);
				server.emit(parsedMessage.type, {
					type: parsedMessage.type,
					data: {
						user: connection!,
						connections: Array.from(connectedClients.values()),
					},
				} satisfies ServerIdentifyMessage);
				break;
			case 'mouse':
				const user = connectedClients.get(socket.id);
				if (!user) return log.debug('[SOCKET] <mouse> <no user found>', socket.id);
				const mouseMessage = {
					type: parsedMessage.type,
					data: { x: parsedMessage.data.x, y: parsedMessage.data.y, user },
				} satisfies ServerMouseMessage;
				server.emit(parsedMessage.type, mouseMessage);
				break;
			case 'node-add':
				server.emit(parsedMessage.type, {
					type: parsedMessage.type,
					data: { node: parsedMessage.data.node },
				} satisfies ServerNodeAddMessage);
				break;
			case 'node-remove':
				server.emit(parsedMessage.type, {
					type: parsedMessage.type,
					data: { nodeId: parsedMessage.data.nodeId },
				} satisfies ServerNodeRemoveMessage);
				break;
			case 'node-position':
				server.emit(parsedMessage.type, {
					type: parsedMessage.type,
					data: {
						nodeId: parsedMessage.data.nodeId,
						position: parsedMessage.data.position,
					},
				} satisfies ServerNodePositionMessage);
				break;
			case 'node-data':
				server.emit(parsedMessage.type, {
					type: parsedMessage.type,
					data: {
						nodeId: parsedMessage.data.nodeId,
						data: parsedMessage.data.data,
					},
				} satisfies ServerNodeDataMessage);
				break;
			case 'edge-remove':
				server.emit(parsedMessage.type, {
					type: parsedMessage.type,
					data: { edgeId: parsedMessage.data.edgeId },
				} satisfies ServerEdgeRemoveMessage);
				break;
			case 'edge-add':
				server.emit(parsedMessage.type, {
					type: parsedMessage.type,
					data: { edge: parsedMessage.data.edge },
				} satisfies ServerEdgeAddMessage);
				break;
			default:
				log.warn('[SOCKET] <unknown message type>', parsedMessage);
				break;
		}
	});

	// Handle disconnection
	socket.on('disconnect', () => {
		log.debug('[SOCKET] <disconnect>', socket.id);
		const connection = connectedClients.get(socket.id);
		connectedClients.delete(socket.id);
		socket.emit('disconnected', {
			type: 'disconnected',
			data: {
				user: connection!,
				connections: Array.from(connectedClients.values()),
			},
		} satisfies ServerMessage);
	});
}
