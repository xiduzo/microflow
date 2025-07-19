import { useSocket } from '@microflow/socket/client';

export function SocketMessageListener(props: { tunnelUrl: string }) {
	useSocket(props.tunnelUrl, {
		onMessage(message) {
			console.debug('<<<< [SOCKET] <message>', message);
		},
	});

	return null;
}
