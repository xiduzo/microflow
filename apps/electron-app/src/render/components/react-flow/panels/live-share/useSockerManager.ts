import { useEffect } from 'react';
import { useSocketStore } from '../../../../stores/socket';

export function useSocketManager() {
	const { status, createSocket, closeSocket } = useSocketStore();

	useEffect(() => {
		if (status.type !== 'shared' && status.type !== 'joined') return;

		createSocket(status.tunnelUrl);

		return () => {
			closeSocket();
		};
	}, [status, createSocket, closeSocket]);
}
