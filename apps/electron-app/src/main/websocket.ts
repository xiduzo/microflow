import { Server } from '@microflow/websocket/server';

export function createWebsocketServer() {
	const server = new Server({
		cors: {
			origin: '*',
			methods: ['GET', 'POST'],
		},
	});

	server.on('connection', socket => {
		console.log(socket);
	});

	server.listen(8888);
}
