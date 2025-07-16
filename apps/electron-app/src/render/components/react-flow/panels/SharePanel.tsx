import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Icon,
	IconName,
	toast,
} from '@microflow/ui';
import { useEffect, useMemo, useRef } from 'react';
import { SharingState, useSharing } from '../../../stores/app';
import { useCopyToClipboard } from 'usehooks-ts';
import { io, Socket } from '@microflow/socket/client';
import { getRandomMessage } from '../../../../common/messages';
import { toBase64 } from '../../../../common/helpers';

export function SharePanel() {
	const { sharing, setSharing } = useSharing();
	const [, copy] = useCopyToClipboard();
	const resolveRef = useRef<(value: string) => void>();

	function hostAction() {
		const type = sharing.type === 'disconnected' ? 'start' : 'stop';
		const promise = new Promise(resolve => (resolveRef.current = resolve));
		window.electron.ipcRenderer.send('ipc-live-share', type);
		toast.promise(promise, { loading: `${type}ing collaboration session` });
	}

	function clientAction() {
		// When leaving -> just stop connecting to the socket
		// when joining -> connect to the socket url passed from the user
		// const promise = new Promise(resolve => (resolveRef.current = resolve));
		//    toast.promise(promise, { loading: `${type}ing live share...` });
	}

	useEffect(() => {
		return window.electron.ipcRenderer.on<SharingState>('ipc-live-share', async result => {
			if (!result.success) return;

			console.debug('<<< ipc-live-share', result);
			setSharing(result.data);

			if (result.data.type !== 'initializing') resolveRef.current?.('');

			switch (result.data.type) {
				case 'initializing':
					if (!result.data.message) return;
					toast.info(result.data.message);
					break;
				case 'connected':
					const tunnelUrl = result.data.tunnelUrl;
					const textToCopy = `Collaborate with me on Microflow Studio: https://microflow.vercel.app/share/${toBase64(tunnelUrl)}\n
Or enter "${toBase64(tunnelUrl)}" in Microflow Studio to join my collaboration session.`;
					try {
						const copied = await copy(textToCopy);
						if (!copied) throw new Error('Failed to copy');
						toast.success('Live session started', {
							id: 'copy',
							description: 'Invitation details copied to clipboard!',
							duration: Infinity,
							action: {
								label: getRandomMessage('action'),
							},
						});
					} catch {
						toast.warning('Ooops...', {
							id: 'copy',
							description: 'Failed to copy invitation details',
							duration: Infinity,
							action: {
								label: 'Copy details',
								onClick: () => {
									toast.promise(copy(textToCopy), {
										loading: 'Copying invitation details',
										success: 'Invitation details copied to clipboard!',
										error: textToCopy,
									});
								},
							},
						});
					}

					break;
				case 'disconnected':
					toast.dismiss('copy');
					break;
				default:
					break;
			}
		});
	}, []);

	useEffect(() => {
		if (sharing.type !== 'connected') return;

		let socket: Socket | null;
		try {
			socket = io(sharing.tunnelUrl, {
				transports: ['websocket'],
				retries: 3,
			});
			socket.io.on('error', error => {
				console.error('Socket connection error', error);
				toast.error('Failed to connect to the collaboration session');
				window.electron.ipcRenderer.send('ipc-live-share', 'stop');
			});

			socket.io.on('close', console.warn);
			socket.io.on('ping', console.info);
			socket.on('connect', () => {
				console.log('Socket connected');
				socket?.emit('message', { foo: 'bar', baz: 6 });
			});
		} catch (error) {
			console.error('Failed to connect to socket:', error);
			window.electron.ipcRenderer.send('ipc-live-share', 'stop');
		}

		return () => {
			socket?.close();
			socket = null;
		};
	}, [sharing]);

	const [title, icon] = useMemo((): [string, IconName] => {
		switch (sharing.type) {
			case 'connected':
				return ['Shared', 'Router'];
			case 'initializing':
				return ['Connecting...', 'RectangleEllipsis'];
			case 'joined':
				return ['Joined', 'RadioReceiver'];
			case 'disconnected':
			default:
				return ['Live share', 'Radio'];
		}
	}, [sharing.type]);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button size="sm" disabled={sharing.type === 'initializing'}>
					<Icon icon={icon} />
					{title}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				{sharing.type === 'connected' && (
					<>
						<DropdownMenuItem onClick={hostAction}>
							<Icon icon="Unplug" />
							Stop your collaboration session
						</DropdownMenuItem>
					</>
				)}
				{sharing.type === 'disconnected' && (
					<>
						<DropdownMenuItem onClick={hostAction}>
							<Icon icon="Router" />
							Start a collaboration session
						</DropdownMenuItem>
						<DropdownMenuItem onClick={clientAction}>
							<Icon icon="RadioReceiver" />
							Join a collaboration session
						</DropdownMenuItem>
					</>
				)}
				{sharing.type === 'joined' && (
					<>
						<DropdownMenuItem onClick={clientAction}>
							<Icon icon="RadioReceiver" />
							Leave the collaboration session
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
