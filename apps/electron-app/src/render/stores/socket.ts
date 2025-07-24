import {
	ClientMessage,
	Connection,
	io,
	ManagerOptions,
	ServerMessage,
	Socket,
	SocketOptions,
} from '@microflow/socket/client';
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import { fromBase64, isBase64 } from '@microflow/utils/base64';

type SocketShared = { type: 'shared'; tunnelUrl: string };
type SocketDisconnected = { type: 'disconnected'; message?: string };
type SocketError = { type: 'error'; message: string };
type SocketInitializing = { type: 'initializing'; message?: string };
type SocketJoined = { type: 'joined'; tunnelUrl: string };

export type SocketStatus =
	| SocketShared
	| SocketDisconnected
	| SocketError
	| SocketInitializing
	| SocketJoined;

type SocketState = {
	status: SocketStatus;
	setStatus: (state: SocketStatus) => void;
	socket: Socket | null;
	createSocket: (urlOrBase64: string, options?: Partial<ManagerOptions & SocketOptions>) => void;
	closeSocket: () => void;
	connections: Connection[];
	addConnection: (connection: Connection) => void;
	removeConnection: (connection: Connection) => void;
};

export const useSocketStore = create<SocketState>((set, get) => {
	return {
		status: { type: 'disconnected' },
		setStatus: (status: SocketStatus) => {
			set({ status });
		},
		socket: null,
		createSocket: (urlOrBase64, options = {}) => {
			console.debug('[SOCKET] <create socket>');
			const url = isBase64(urlOrBase64) ? fromBase64(urlOrBase64) : urlOrBase64;
			const socket = io(url, {
				transports: ['websocket'],
				...options,
			});
			const { status } = get();
			socket.io.on('error', error => {
				console.debug('[SOCKET] <error>', error);
				window.electron.ipcRenderer.send('ipc-live-share', {
					type: status.type === 'shared' ? 'stop' : 'leave',
				});
			});
			socket.io.on('close', error => {
				console.debug('[SOCKET] <close>', error);
				window.electron.ipcRenderer.send('ipc-live-share', {
					type: status.type === 'shared' ? 'stop' : 'leave',
				});
			});
			set({ socket });
		},
		closeSocket: () => {
			console.debug('[SOCKET] <close socket>');
			const { socket } = get();
			socket?.close();
			set({ socket: null });
		},
		connections: [],
		addConnection: (connection: Connection) => {
			set(state => ({ connections: [...state.connections, connection] }));
		},
		removeConnection: (connection: Connection) => {
			set(state => ({ connections: state.connections.filter(c => c.id !== connection.id) }));
		},
	};
});

type ExtractServerMessage<T extends ServerMessage['type'] = ServerMessage['type']> = Extract<
	ServerMessage,
	{ type: T }
>;

export function useSocketListener<
	ReceiveType extends ServerMessage = ServerMessage,
	Type extends ReceiveType['type'] = ReceiveType['type'],
>(type: Type, callback: (message: ExtractServerMessage<Type>) => void) {
	const { socket } = useSocketStore(useShallow(state => ({ socket: state.socket })));

	useEffect(() => {
		console.debug('[SOCKET] <on>', type);
		socket?.on(type as string, message => {
			console.debug('[SOCKET] <message>', type, message);
			let parsedMessage = message;
			if (typeof message === 'string') {
				try {
					parsedMessage = JSON.parse(message);
					console.debug('[SOCKET] <parsed>', parsedMessage);
				} catch (error) {
					console.debug('[SOCKET] <parse error>', message, error);
				}
			}
			callback(parsedMessage);
		});

		return () => {
			console.debug('[SOCKET] <off>', type);
			socket?.off(type as string, callback);
		};
	}, [socket, type, callback]);
}

export function useSocketSender<SendType = ClientMessage>() {
	const { socket } = useSocketStore(useShallow(state => ({ socket: state.socket })));

	const send = useCallback(
		(message: SendType) => {
			if (!socket?.connected) return console.debug('[SOCKET] <send> socket not connected!');
			console.debug('[SOCKET] <send>', message);
			socket?.send(message);
		},
		[socket],
	);

	return { send };
}
