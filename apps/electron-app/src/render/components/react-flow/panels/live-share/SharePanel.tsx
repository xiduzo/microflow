import {
	Button,
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Icon,
	IconName,
	Input,
	toast,
	useForm,
	zodResolver,
	Zod,
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from '@microflow/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SharingState, useSharing } from '../../../../stores/app';
import { useCopyToClipboard } from 'usehooks-ts';
import { useSocket } from '@microflow/socket/client';
import { getRandomMessage } from '../../../../../common/messages';
import { toBase64 } from '@microflow/utils/base64';
import { SocketMessageListener } from './SocketMessageListener';

const schema = Zod.object({
	code: Zod.string().min(1, 'Tunnel code is required'),
});

type Schema = Zod.infer<typeof schema>;

export function SharePanel() {
	const { sharing, setSharing } = useSharing();
	const [, copy] = useCopyToClipboard();
	const resolveRef = useRef<(value: string) => void>();
	const [joining, setJoining] = useState(false);
	const form = useForm({
		resolver: zodResolver(schema),
		defaultValues: {
			code: '',
		},
	});

	const { send } = useSocket('tunnelUrl' in sharing ? sharing.tunnelUrl : undefined, {
		onError: () =>
			window.electron.ipcRenderer.send('ipc-live-share', {
				type: sharing.type === 'disconnected' ? 'stop' : 'leave',
			}),
		onSuccess: () => {
			send('message', { type: 'identify', data: { name: 'xiduzo' } });
		},
	});

	function hostAction() {
		const type = sharing.type === 'disconnected' ? 'start' : 'stop';
		const promise = new Promise(resolve => (resolveRef.current = resolve));
		window.electron.ipcRenderer.send('ipc-live-share', { type });
		toast.promise(promise, { loading: `${type}ing collaboration session` });
	}

	function clientAction(data?: Schema) {
		const type = sharing.type === 'disconnected' ? 'join' : 'leave';
		window.electron.ipcRenderer.send('ipc-live-share', { type, code: data?.code });
		const promise = new Promise(resolve => (resolveRef.current = resolve));
		toast.promise(promise, { id: 'client', loading: `${type}ing live share...` });
	}

	useEffect(() => {
		return window.electron.ipcRenderer.on<SharingState>('ipc-live-share', async result => {
			if (!result.success) return;

			console.debug('<<<< [SharePanel] <ipc-live-share>', result);
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
Or enter the tunnel code "${toBase64(tunnelUrl)}" in Microflow Studio to join my collaboration session.`;
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
				case 'joined':
					toast.success('Joined collaboration session');
					setJoining(false);
					form.reset();
					break;
				case 'disconnected':
					toast.dismiss('copy');
					if (result.data.message) toast.info(result.data.message);
					break;
				default:
					break;
			}
		});
	}, []);

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
		<>
			{'tunnelUrl' in sharing && <SocketMessageListener tunnelUrl={sharing.tunnelUrl} />}
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
							<DropdownMenuItem onClick={() => setJoining(true)}>
								<Icon icon="RadioReceiver" />
								Join a collaboration session
							</DropdownMenuItem>
						</>
					)}
					{sharing.type === 'joined' && (
						<>
							<DropdownMenuItem onClick={() => clientAction()}>
								<Icon icon="RadioReceiver" />
								Leave the collaboration session
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={joining} onOpenChange={setJoining}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Join a collaboration session</DialogTitle>
						<DialogDescription>
							Enter the session code to join a collaboration session.
						</DialogDescription>
					</DialogHeader>
					<Form {...form}>
						<form onSubmit={form.handleSubmit(clientAction)}>
							<fieldset className="mb-6">
								<FormField
									control={form.control}
									name="code"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Session code</FormLabel>
											<FormControl>
												<Input
													placeholder="aHR0cHM6Ly93aW4tZG9taW5pY2FuLWhlYWQtd2luc3Rvbi50cnljbG91ZGZsYXJlLmNvbQ=="
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</fieldset>
							<DialogFooter>
								<DialogClose asChild>
									<Button type="button" variant="secondary">
										Cancel
									</Button>
								</DialogClose>
								<Button type="submit" disabled={sharing.type === 'initializing'}>
									Join session
								</Button>
							</DialogFooter>
						</form>
					</Form>
				</DialogContent>
			</Dialog>
		</>
	);
}
