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
import { useMemo, useState } from 'react';
import { useSocketStore } from '../../../../stores/socket';
import { useShareListener } from './useShareListener';
import { useSocketManager } from './useSockerManager';

const schema = Zod.object({
	code: Zod.string().min(1, 'Tunnel code is required'),
});

type Schema = Zod.infer<typeof schema>;

export function SharePanel() {
	const { status } = useSocketStore();
	const [joining, setJoining] = useState(false);
	const form = useForm({
		resolver: zodResolver(schema),
		defaultValues: {
			code: '',
		},
	});
	useShareListener();
	useSocketManager();

	function hostAction() {
		const type = status.type === 'disconnected' ? 'start' : 'stop';
		window.electron.ipcRenderer.send('ipc-live-share', { type });
		toast.info(`${type}ing collaboration session`);
	}

	function clientAction(data?: Schema) {
		const type = status.type === 'disconnected' ? 'join' : 'leave';
		window.electron.ipcRenderer.send('ipc-live-share', {
			type,
			code: data?.code,
		});
		toast.info(`${type}ing live share...`);
		form.reset();
		setJoining(false);
	}

	const [title, icon] = useMemo((): [string, IconName] => {
		switch (status.type) {
			case 'shared':
				return ['Shared', 'Router'];
			case 'initializing':
				return ['Connecting...', 'RectangleEllipsis'];
			case 'joined':
				return ['Joined', 'RadioReceiver'];
			case 'disconnected':
			default:
				return ['Live share', 'Radio'];
		}
	}, [status.type]);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button size='sm' disabled={status.type === 'initializing'}>
						<Icon icon={icon} />
						{title}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align='start'>
					{status.type === 'shared' && (
						<>
							<DropdownMenuItem onClick={hostAction}>
								<Icon icon='Unplug' />
								Stop your collaboration session
							</DropdownMenuItem>
						</>
					)}
					{status.type === 'disconnected' && (
						<>
							<DropdownMenuItem onClick={hostAction}>
								<Icon icon='Router' />
								Start a collaboration session
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => setJoining(true)}>
								<Icon icon='RadioReceiver' />
								Join a collaboration session
							</DropdownMenuItem>
						</>
					)}
					{status.type === 'joined' && (
						<>
							<DropdownMenuItem onClick={() => clientAction()}>
								<Icon icon='RadioReceiver' />
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
							<fieldset className='mb-6'>
								<FormField
									control={form.control}
									name='code'
									render={({ field }) => (
										<FormItem>
											<FormLabel>Session code</FormLabel>
											<FormControl>
												<Input placeholder='Enter session code or URL' {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</fieldset>
							<DialogFooter>
								<DialogClose asChild>
									<Button type='button' variant='secondary'>
										Cancel
									</Button>
								</DialogClose>
								<Button type='submit' disabled={status.type === 'initializing'}>
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
