import { useEffect, useRef, useCallback } from 'react';
import { fromBase64 } from '@microflow/utils/base64';
import { io, type Socket, type ManagerOptions, type SocketOptions } from 'socket.io-client';
import { ClientMessage, ServerMessage } from '../common/types';

function isBase64(str: string) {
	return /^[A-Za-z0-9+/=]+$/.test(str) && !/^https?:\/\//.test(str);
}

type ErrorCallback = (error?: unknown) => void;
type SuccessCallback = () => void;
type MessageCallback<ReceiveType = ServerMessage> = (message: ReceiveType) => void;

type CustomOptions<ReceiveType = ServerMessage> = {
	onError?: ErrorCallback;
	onSuccess?: SuccessCallback;
	onMessage?: MessageCallback<ReceiveType>;
	subscriptions?: string[];
};

export function useSocket<
	ReceiveType = ServerMessage,
	SendType = ClientMessage,
	AllowedMessages extends string = 'message',
>(
	urlOrBase64?: string,
	options?: Partial<ManagerOptions & SocketOptions & CustomOptions<ReceiveType>>,
) {
	const socketRef = useRef<Socket | null>(null);

	useEffect(() => {
		if (!urlOrBase64) return;
		const url = isBase64(urlOrBase64) ? fromBase64(urlOrBase64) : urlOrBase64;
		const socket = io(url, {
			transports: ['websocket'],
			retries: 3,
			...options,
		});
		socketRef.current = socket;

		socket.io.on('error', error => options?.onError?.(error));
		socket.io.on('close', console.warn);
		socket.on('connect', () => options?.onSuccess?.());
		socket.on('message', (message: ServerMessage) => {
			console.debug('<<<< [SOCKET] <message>', message);
			let parsedMessage = message;
			if (typeof message === 'string') {
				try {
					parsedMessage = JSON.parse(message) as ServerMessage;
					console.debug('<<<< [SOCKET] <parsedMessage>', parsedMessage);
				} catch (error) {
					console.debug('[SOCKET] <parse>', message, error);
				}
			}
			options?.onMessage?.(parsedMessage as unknown as ReceiveType);
		});
		return () => {
			socket.disconnect();
			socketRef.current = null;
		};
	}, [urlOrBase64, options]);

	const send = useCallback((event: AllowedMessages, send: SendType) => {
		console.debug('>>>> [SOCKET] <send>', event, send);
		socketRef.current?.emit(event, send);
	}, []);

	return { send };
}
