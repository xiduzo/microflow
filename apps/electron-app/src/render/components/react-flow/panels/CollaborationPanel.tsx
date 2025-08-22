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
import { useCollaborationActions, useCollaborationState } from '../../../stores/yjs';
import { UndoRedoControls } from './UndoRedoControls';
import { JoinCollaborationDialog } from './JoinCollaborationDialog';
import { Users } from 'lucide-react';
import { useCopyToClipboard } from 'usehooks-ts';

export function CollaborationPanel() {
	const { connect, disconnect } = useCollaborationActions();
	const { status, peers } = useCollaborationState();
	const [joinDialogOpen, setJoinDialogOpen] = useState(false);
	const [, copyToClipboard] = useCopyToClipboard();

	function hostAction() {
		// const roomName = `microflow-${Math.random().toString(36).substring(2, 8)}`;
		const roomName = `microflow`;
		connect(roomName);
		toast.success('Started collaboration session', {
			description: `Room: ${roomName}`,
		});
		copyToClipboard(roomName);
	}

	function clientAction() {
		if (status.type === 'connected') {
			disconnect();
			toast.info('Left collaboration session');
		} else {
			setJoinDialogOpen(true);
		}
	}

	const [title, icon] = useMemo((): [string, IconName] => {
		switch (status.type) {
			case 'connected':
				return [`${peers} peers`, 'Users'];
			case 'connecting':
				return ['Connecting...', 'RectangleEllipsis'];
			case 'error':
				return ['Error', 'AlertTriangle'];
			case 'disconnected':
			default:
				return ['Collaborate', 'Users'];
		}
	}, [status.type, peers]);

	return (
		<>
			<div className='flex items-center gap-2'>
				<UndoRedoControls />
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant='outline' size='sm' className='gap-2'>
							<Icon icon={icon} className='h-4 w-4' />
							{title}
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align='end'>
						{status.type === 'disconnected' && (
							<>
								<DropdownMenuItem onClick={hostAction}>
									<Icon icon='Radio' className='h-4 w-4 mr-2' />
									Start session
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setJoinDialogOpen(true)}>
									<Icon icon='RadioReceiver' className='h-4 w-4 mr-2' />
									Join session
								</DropdownMenuItem>
							</>
						)}
						{status.type === 'connected' && (
							<>
								<DropdownMenuItem onClick={clientAction}>
									<Icon icon='RadioReceiver' className='h-4 w-4 mr-2' />
									Leave session
								</DropdownMenuItem>
								<DropdownMenuItem disabled>
									<Users className='h-4 w-4 mr-2' />
									{peers} peer{peers !== 1 ? 's' : ''} connected
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<JoinCollaborationDialog open={joinDialogOpen} onOpenChange={setJoinDialogOpen} />
		</>
	);
}
