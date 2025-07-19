import {
	ClientMessage,
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
				retries: 3,
				...options,
			});
			const { status } = get();
			socket.io.on('error', error => {
				console.debug('[SOCKET] <error>', error);
				window.electron.ipcRenderer.send('ipc-live-share', {
					type: status.type === 'disconnected' ? 'stop' : 'leave',
				});
			});
			socket.io.on('close', error => {
				console.debug('[SOCKET] <close>', error);
				window.electron.ipcRenderer.send('ipc-live-share', {
					type: status.type === 'disconnected' ? 'stop' : 'leave',
				});
			});
			set({ socket });
		},
		closeSocket: () => {
			console.debug('[SOCKET] <close socket>');
			const { socket } = get();
			if (!socket) return;
			socket.close();
			set({ socket: null });
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
		socket?.on(type as string, message => {
			console.debug('<<<< [SOCKET] <message>', type, message);
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
			socket?.off(type as string, callback);
		};
	}, [socket, type, callback]);
}

export function useSocketSender<SendType = ClientMessage>(event: string = 'message') {
	const { socket } = useSocketStore(useShallow(state => ({ socket: state.socket })));

	const send = useCallback(
		(message: SendType) => {
			// if (socket) console.debug('>>>> [SOCKET] <send>', event, message);
			socket?.emit(event, message);
		},
		[socket, event],
	);

	return { send };
}
