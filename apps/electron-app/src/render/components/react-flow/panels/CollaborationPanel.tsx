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
import { generateOTP, formatOTP } from '../../../../common/otp';

export function CollaborationPanel() {
	const { connect, disconnect } = useCollaborationActions();
	const { status, peers } = useCollaborationState();
	const [joinDialogOpen, setJoinDialogOpen] = useState(false);
	const [, copyToClipboard] = useCopyToClipboard();

	function hostAction() {
		const otpCode = generateOTP();
		connect(otpCode);
		toast.success('Started collaboration session', {
			description: `Session code: ${formatOTP(otpCode)}`,
		});
		copyToClipboard(otpCode);
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
				const otpCode = status.roomName.replace('microflow-', '');
				return [`${formatOTP(otpCode)} • ${peers} peers`, 'Users'];
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
								<DropdownMenuItem
									onClick={() => {
										const otpCode = status.roomName.replace('microflow-', '');
										copyToClipboard(otpCode);
										toast.success('Session code copied to clipboard');
									}}
								>
									<Icon icon='ClipboardCopy' className='h-4 w-4 mr-2' />
									Copy session code
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
