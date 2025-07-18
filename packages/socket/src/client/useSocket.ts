import { useEffect, useRef, useCallback } from 'react';
import { fromBase64 } from '@microflow/utils/base64';
import { io, Socket, ManagerOptions, SocketOptions } from 'socket.io-client';

function isBase64(str: string) {
	return /^[A-Za-z0-9+/=]+$/.test(str) && !/^https?:\/\//.test(str);
}

type ErrorCallback = (error?: unknown) => void;
type SuccessCallback = () => void;

type CustomOptions = {
	onError?: ErrorCallback;
	onSuccess?: SuccessCallback;
};

export function useSocket(
	urlOrBase64?: string,
	options?: Partial<ManagerOptions & SocketOptions & CustomOptions>,
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
		socket.io.on('error', error => options?.onError?.(error));
		socket.io.on('close', console.warn);
		socket.on('connect', () => options?.onSuccess?.());
		socketRef.current = socket;
		return () => {
			socket.disconnect();
			socketRef.current = null;
		};
	}, [urlOrBase64, options]);

	const send = useCallback((event: string, ...args: any[]) => {
		socketRef.current?.emit(event, ...args);
	}, []);

	return { send };
}
