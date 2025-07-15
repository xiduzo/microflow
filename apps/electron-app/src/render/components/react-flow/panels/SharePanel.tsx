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
import { compressToEncodedURIComponent } from 'lz-string';
import { toBase64 } from '../../../../common/helpers';

export function SharePanel() {
	const { sharing, setSharing } = useSharing();
	const [, copy] = useCopyToClipboard();
	const resolveRef = useRef<(value: string) => void>();

	function hostAction() {
		const type = sharing.type === 'disconnected' ? 'start' : 'stop';
		const promise = new Promise(resolve => (resolveRef.current = resolve));
		window.electron.ipcRenderer.send('ipc-live-share', type);
		toast.promise(promise, { loading: `${type}ing live session...` });
		setSharing({ type: 'initializing' });
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
					const textToCopy = `Check out my Microflow Studio project: https://microflow.vercel.app/share/${toBase64(tunnelUrl)}\n
Or enter "${toBase64(tunnelUrl)}" in Microflow Studio to join my live session.`;
					try {
						const copied = await copy(textToCopy);
						if (!copied) throw new Error('Failed to copy');
						toast.success('Live session started', {
							description: 'We copied the share link to your clipboard',
							duration: Infinity,
							action: {
								label: getRandomMessage('action'),
							},
						});
					} catch {
						toast.warning('Ooops...', {
							description: 'Failed to copy share link to clipboard',
							duration: Infinity,
							action: {
								label: 'Copy link',
								onClick: () => {
									toast.promise(copy(textToCopy), {
										loading: 'Copying share link...',
										success: 'Share link copied to clipboard',
										error: textToCopy,
									});
								},
							},
						});
					}

					break;
				case 'disconnected':
					toast.success('Sharing stopped');
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
			console.log('>>>>', compressToEncodedURIComponent(sharing.tunnelUrl));
			socket = io(sharing.tunnelUrl, {
				transports: ['websocket'],
				retries: 3,
			});
			socket.io.on('error', console.error);

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
				return ['Hosting live session', 'Router'];
			case 'initializing':
				return ['Connecting...', 'RectangleEllipsis'];
			case 'joined':
				return ['Joined live session', 'RadioReceiver'];
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
							Stop your live session
						</DropdownMenuItem>
					</>
				)}
				{sharing.type === 'disconnected' && (
					<>
						<DropdownMenuItem onClick={hostAction}>
							<Icon icon="Router" />
							Start a live session
						</DropdownMenuItem>
						<DropdownMenuItem onClick={clientAction}>
							<Icon icon="RadioReceiver" />
							Join a live session
						</DropdownMenuItem>
					</>
				)}
				{sharing.type === 'joined' && (
					<>
						<DropdownMenuItem onClick={clientAction}>
							<Icon icon="RadioReceiver" />
							Leave the live session
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
