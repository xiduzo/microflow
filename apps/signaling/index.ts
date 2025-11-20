#!/usr/bin/env node

import { WebSocketServer, WebSocket, CONNECTING, OPEN } from 'ws';
import http from 'http';
import * as map from 'lib0/map';

const port = process.env.PORT || 4444;

const server = http.createServer((request, response) => {
	response.writeHead(200, { 'Content-Type': 'text/plain' });
	response.end('okay');
});

const wss = new WebSocketServer({ noServer: true });

const topics = new Map<string, Set<WebSocket>>();

const PING_TIMEOUT = 30_000;

const send = (websocket: WebSocket, message: Record<string, unknown>) => {
	if (websocket.readyState !== CONNECTING && websocket.readyState !== OPEN) {
		websocket.close();
		return;
	}

	try {
		websocket.send(JSON.stringify(message));
	} catch (e) {
		console.error('[SIGNALING] error sending message', e);
		websocket.close();
	}
};

const onConnection = (websocket: WebSocket) => {
	const subscribedTopics = new Set<string>();
	let closed = false;

	// Check if connection is still alive
	let pongReceived = true;
	const pingInterval = setInterval(() => {
		if (!pongReceived) {
			websocket.close();
			clearInterval(pingInterval);
			return;
		}

		pongReceived = false;
		try {
			websocket.ping();
		} catch (e) {
			websocket.close();
		}
	}, PING_TIMEOUT);

	websocket.on('pong', () => {
		pongReceived = true;
	});

	websocket.on('close', () => {
		subscribedTopics.forEach(topicName => {
			const subs = topics.get(topicName) || new Set();
			subs.delete(websocket);
			if (subs.size > 0) return;
			topics.delete(topicName);
		});
		subscribedTopics.clear();
		closed = true;
		clearInterval(pingInterval);
	});

	websocket.on('message', (message: Buffer | string) => {
		if (closed) return;

		let parsedMessage: { type: string; [key: string]: unknown };
		if (typeof message === 'string' || message instanceof Buffer) {
			try {
				parsedMessage = JSON.parse(message.toString());
			} catch (e) {
				return;
			}
		} else {
			parsedMessage = message;
		}

		if (!parsedMessage?.type) return;

		switch (parsedMessage.type) {
			case 'subscribe': {
				const topicsList = parsedMessage.topics || [];
				if (!Array.isArray(topicsList)) return;

				topicsList.forEach((topicName: string) => {
					if (typeof topicName !== 'string') return;

					const topic = map.setIfUndefined(topics, topicName, () => new Set());
					topic.add(websocket);
					subscribedTopics.add(topicName);
				});
				break;
			}

			case 'unsubscribe': {
				const topicsList = parsedMessage.topics || [];
				if (!Array.isArray(topicsList)) return;

				topicsList.forEach((topicName: string) => {
					const subs = topics.get(topicName);
					if (!subs) {
						subscribedTopics.delete(topicName);
						return;
					}

					subs.delete(websocket);
					if (subs.size === 0) {
						topics.delete(topicName);
					}
					subscribedTopics.delete(topicName);
				});
				break;
			}

			case 'publish': {
				if (!parsedMessage.topic) return;

				const receivers = topics.get(String(parsedMessage.topic));
				if (!receivers) return;

				parsedMessage.clients = receivers.size;
				receivers.forEach(receiver => send(receiver, parsedMessage));
				break;
			}

			case 'ping':
				send(websocket, { type: 'pong' });
				break;
		}
	});
};

wss.on('connection', onConnection);

// Handle HTTP upgrade requests
server.on('upgrade', (request, socket, head) => {
	wss.handleUpgrade(request, socket, head, ws => {
		wss.emit('connection', ws, request);
	});
});

server.listen(port, () => {
	console.log('[SIGNALING] server running on localhost:', port);
});
