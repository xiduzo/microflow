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
import { useMemo, useState } from 'react';
import { useSocketStore } from '../../../../stores/socket';
import { useShareIpcListener } from './useShareIpcListener';
import { useSocketManager } from './useSockerManager';
import { JoinSessionDialog } from './JoinSessionDialog';

export function SharePanel() {
	const { status } = useSocketStore();
	const [joinDialogOpen, setJoinDialogOpen] = useState(false);
	useShareIpcListener();
	useSocketManager();

	function hostAction() {
		const type = status.type === 'disconnected' ? 'start' : 'stop';
		window.electron.ipcRenderer.send('ipc-live-share', { type });
		toast.info(`${type}ing collaboration session`);
	}

	function clientAction() {
		const type = status.type === 'disconnected' ? 'join' : 'leave';
		window.electron.ipcRenderer.send('ipc-live-share', {
			type,
		});
		toast.info(`${type}ing live share...`);
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
							<DropdownMenuItem onClick={() => setJoinDialogOpen(true)}>
								<Icon icon='RadioReceiver' />
								Join a collaboration session
							</DropdownMenuItem>
						</>
					)}
					{status.type === 'joined' && (
						<>
							<DropdownMenuItem onClick={clientAction}>
								<Icon icon='RadioReceiver' />
								Leave the collaboration session
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<JoinSessionDialog open={joinDialogOpen} onOpenChange={setJoinDialogOpen} />
		</>
	);
}
