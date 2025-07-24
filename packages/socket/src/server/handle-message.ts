import { Server, Socket } from "socket.io";
import { ClientMessage, Connection, ServerMessage } from "../common/types";
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

export function handleSocket(socket: Socket, server: Server, connectedClients: Map<string, Connection>) {
        log.debug('[SOCKET] <connection>', socket.id);
        connectedClients.set(socket.id, { id: socket.id, name: 'unknown' });
        const connection = connectedClients.get(socket.id);
        socket.emit("connected", { type: 'connected', data: { user: connection!, connections: Array.from(connectedClients.values()) } } satisfies ServerMessage);

        // Add error handler for the socket
        socket.on('error', (error) => {
            log.error('[SOCKET] <socket error>', socket.id, error);
        });

        socket.on('message', (message: ClientMessage, ack?: (val: string) => void) => {
            ack?.("ACK");
            const parsedMessage = parseMessage(message);
            log.debug(`[SOCKET] <message> by ${socket.id}`, parsedMessage, typeof parsedMessage);

            switch (parsedMessage.type) {
                case 'identify':
                    connectedClients.set(socket.id, { id: socket.id, name: parsedMessage.data.name });
                    const connection = connectedClients.get(socket.id);
                    server.emit(parsedMessage.type, {
                        type: parsedMessage.type,
                        data: { user: connection!, connections: Array.from(connectedClients.values()) },
                    } satisfies ServerMessage);
                    break;
                case 'mouse':
                    const user = connectedClients.get(socket.id);
                    if (!user) return log.debug('[SOCKET] <mouse> <no user found>', socket.id);
                    const mouseMessage = {
                        type: parsedMessage.type,
                        data: { x: parsedMessage.data.x, y: parsedMessage.data.y, user },
                    } satisfies ServerMessage;
                    server.emit(parsedMessage.type, mouseMessage);
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
            socket.emit("disconnected", { type: 'disconnected', data: { user: connection!, connections: Array.from(connectedClients.values()) } } satisfies ServerMessage);
        });
}
