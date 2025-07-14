import { Icon, toast, Toggle } from '@microflow/ui';
import { useEffect, useRef } from 'react';
import { SharingState, useSharing } from '../../../stores/app';
import { useCopyToClipboard } from 'usehooks-ts';
import { io } from '@microflow/socket/client';

export function SharePanel() {
	const { sharing, setSharing } = useSharing();
	const [, copy] = useCopyToClipboard();
	const resolveRef = useRef<(value: string) => void>();

	function toggleShare() {
		const promise = new Promise(resolve => (resolveRef.current = resolve));

		switch (sharing.type) {
			case 'connected':
				window.electron.ipcRenderer.send('ipc-live-share', 'stop');
				toast.promise(promise, { loading: 'Stopping live share...' });
				break;
			case 'disconnected':
			case 'error':
				window.electron.ipcRenderer.send('ipc-live-share', 'start');
				toast.promise(promise, { loading: 'Staring live share...' });
				break;
			case 'initializing':
			default:
				// Do nothing if already initializing
				break;
		}
	}

	useEffect(() => {
		return window.electron.ipcRenderer.on<SharingState>('ipc-live-share', async result => {
			if (!result.success) return;

			console.debug('<<< ipc-live-share', result);
			setSharing(result.data);

			const actionLabels = [
				'Roger that',
				'Got it',
				'Understood',
				'Copy that',
				'Affirmative',
				'Okay',
				'Will do',
				'On it',
				'Sure thing',
				'Absolutely',
				'Right away',
				'You got it',
			];

			switch (result.data.type) {
				case 'connected':
					const tunnelUrl = result.data.tunnelUrl;
					resolveRef.current?.(tunnelUrl);
					try {
						const copied = await copy(tunnelUrl);
						if (!copied) throw new Error('Failed to copy');
						toast.success('Sharing started', {
							description: 'We copied the share link to your clipboard',
							duration: Infinity,
							action: {
								label: actionLabels.at(Math.floor(Math.random() * actionLabels.length)),
							},
						});
					} catch {
						toast.warning('Ooops...', {
							description: 'Failed to copy share link to clipboard',
							duration: Infinity,
							action: {
								label: 'Copy link',
								onClick: () => {
									toast.promise(copy(tunnelUrl), {
										loading: 'Copying share link...',
										success: 'Share link copied to clipboard',
										error: tunnelUrl,
									});
								},
							},
						});
					}

					break;
				case 'disconnected':
					resolveRef.current?.('');
					toast.success('Sharing stopped');
					break;
				default:
					break;
			}
		});
	}, []);

	useEffect(() => {
		if (sharing.type !== 'connected') return;
		// console.log(io, sharing.tunnelUrl);
		// const url = sharing.tunnelUrl;
		// const socket = new WebSocket(url.replace('https://', 'wss://'));
		// socket.onmessage = event => {
		// 	const data = JSON.parse(event.data);
		// 	console.log('Received message:', data);
		// };
		// socket.onerror = error => {
		// 	console.error('WebSocket error:', error);
		// 	// window.electron.ipcRenderer.send('ipc-live-share', 'stop');
		// };
		// socket.onclose = () => {
		// 	console.warn('WebSocket connection closed');
		// 	// window.electron.ipcRenderer.send('ipc-live-share', 'stop');
		// };
		// socket.onopen = () => {
		// 	console.log('WebSocket connection established');
		// 	// You can send messages to the server here if needed
		// 	// socket.send(JSON.stringify({ foo: 'bar', baz: 6 }));
		// };
		// console.log('connecting to', url);
		// const socket = io(url.replace('https://', 'wss://'), {
		// 	transports: ['websocket'],
		// 	secure: true,
		// 	upgrade: false,
		// });
		// socket.io.on('error', console.error);
		// socket.on('connect_error', err => {
		// 	// the reason of the error, for example "xhr poll error"
		// 	console.log(err.message);

		// 	// some additional description, for example the status code of the initial HTTP response
		// 	console.log(err.description);

		// 	// some additional context, for example the XMLHttpRequest object
		// 	console.log(err.context);
		// 	window.electron.ipcRenderer.send('ipc-live-share', 'stop');
		// });
		// socket.io.on('close', console.warn);
		// // socket.io.on('ping', console.info);
		// socket.on('connect', () => {
		// 	console.log('Socket connected');
		// 	// socket.emit('message', { foo: 'bar', baz: 6 });
		// });

		return () => {
			// socket.close();
		};
	}, [sharing]);

	return (
		<Toggle onClick={toggleShare} disabled={sharing.type === 'initializing'}>
			{sharing.type === 'connected' && <Icon icon="Zap" className="text-green-500" />}
			{sharing.type === 'disconnected' && <Icon icon="ZapOff" />}
		</Toggle>
	);
}
