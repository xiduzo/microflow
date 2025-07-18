import { Socket, Server } from 'socket.io';

type Connection = {
	id: string;
	name: string;
};

const connectedClients = new Map<string, Connection>();

export function handleSocket(socket: Socket, server: Server) {
	console.log('A user connected');

	// Listen for messages from the client
	socket.on('message', msg => {
		console.log('Message received:', msg);

		// Send a response back to the client
		socket.emit('message', `Server received: ${msg}`);

		// Sending data to all connected clients
		socket.emit('message', `Broadcast: ${msg}`);
	});

	// Handle disconnection
	socket.on('disconnect', () => {
		console.log('A user disconnected');
	});
	// connectedClients.set(socket.id, { id: socket.id, name: `User ${socket.id}` });
	// socket.broadcast.emit('message', { type: 'connect', id: socket.id });

	// socket.on('message', msg => {
	// 	socket.broadcast.emit('message', { type: 'message', id: socket.id, message: msg });
	// });

	// socket.on('disconnect', () => {
	// 	socket.broadcast.emit('message', { type: 'disconnect', id: socket.id });
	// 	connectedClients.delete(socket.id);
	// });
}
