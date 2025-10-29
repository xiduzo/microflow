import {
	Button,
	cn,
	Dock,
	DockIcon,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
	Icon,
	Separator,
	toast,
} from '@microflow/ui';
import { useCollaborationActions, useCollaborationState } from '../../../stores/yjs';
import { useReactFlow } from '@xyflow/react';
import { HexColorPicker } from 'react-colorful';
import { getRandomUniqueUserName } from '../../../../common/unique';
import { useAppStore } from '../../../stores/app';
import { KbdAccelerator } from '../../KeyboardShortcut';
import { useShallow } from 'zustand/shallow';
import { useNewNodeStore } from '../../../stores/new-node';
import { useState } from 'react';
import { JoinCollaborationDialog } from './JoinCollaborationDialog';
import { useCopyToClipboard } from 'usehooks-ts';
import { formatOTP, generateOTP } from '../../../../common/otp';

export function DockPanel() {
	const { undo, redo, canUndo, canRedo } = useCollaborationActions();
	const { zoomIn, zoomOut, fitView } = useReactFlow();
	const setOpen = useNewNodeStore(useShallow(state => state.setOpen));

	return (
		<Dock>
			<DockIcon>
				<Settings />
			</DockIcon>

			<DockIcon>
				<Collaboration />
			</DockIcon>
			<Separator orientation='vertical' className='h-full' />
			<DockIcon>
				<Button variant='ghost' size='icon' disabled={!canUndo()} onClick={undo}>
					<Icon icon='Undo' />
				</Button>
			</DockIcon>
			<DockIcon>
				<Button variant='ghost' size='icon' disabled={!canRedo()} onClick={redo}>
					<Icon icon='Redo' />
				</Button>
			</DockIcon>
			<Separator orientation='vertical' className='h-full' />
			<DockIcon>
				<Button variant='ghost' size='icon' onClick={() => setOpen(true)}>
					<Icon icon='Plus' />
				</Button>
			</DockIcon>
			<Separator orientation='vertical' className='h-full' />
			<DockIcon>
				<Button variant='ghost' size='icon' onClick={() => zoomIn({ duration: 150 })}>
					<Icon icon='ZoomIn' />
				</Button>
			</DockIcon>
			<DockIcon>
				<Button variant='ghost' size='icon' onClick={() => zoomOut({ duration: 150 })}>
					<Icon icon='ZoomOut' />
				</Button>
			</DockIcon>
			<DockIcon>
				<Button variant='ghost' size='icon' onClick={() => fitView({ duration: 300 })}>
					<Icon icon='Fullscreen' />
				</Button>
			</DockIcon>
		</Dock>
	);
}

function Settings() {
	const [settingsOpen, setSettingsOpen] = useState(false);

	return (
		<DropdownMenu onOpenChange={setSettingsOpen}>
			<DropdownMenuTrigger asChild>
				<Button variant={settingsOpen ? 'default' : 'ghost'} size='icon'>
					<Icon icon='Settings' />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuItem>
					<Icon icon='Microchip' />
					Microcontroller settings
				</DropdownMenuItem>
				<DropdownMenuItem>
					<Icon icon='RadioTower' />
					MQTT settings
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function Collaboration() {
	const { connect, disconnect } = useCollaborationActions();

	const [joinDialogOpen, setJoinDialogOpen] = useState(false);
	const { status } = useCollaborationState();
	const [collaborateOpen, setCollaborateOpen] = useState(false);
	const [, copyToClipboard] = useCopyToClipboard();

	function hostAction() {
		const otpCode = generateOTP();
		connect(otpCode);
		toast.success('Started collaboration session', {
			description: `Session code: ${formatOTP(otpCode)}`,
		});
		copyToClipboard(otpCode);
	}

	async function copySessionCode() {
		if (status.type !== 'connected') return;
		await copyToClipboard(status.roomName.replace('microflow-', ''));
		toast.success('Session code copied to clipboard', {
			description: formatOTP(status.roomName.replace('microflow-', '')),
		});
	}

	return (
		<>
			<JoinCollaborationDialog open={joinDialogOpen} onOpenChange={setJoinDialogOpen} />
			<DropdownMenu onOpenChange={setCollaborateOpen}>
				<DropdownMenuTrigger asChild>
					<Button variant={collaborateOpen ? 'default' : 'ghost'} size='icon'>
						<Icon icon='Share2' />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					{status.type !== 'connected' && (
						<>
							<DropdownMenuItem onClick={hostAction}>
								<Icon icon='Share2' />
								Start collaboration session
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => setJoinDialogOpen(true)}>
								<Icon icon='RadioReceiver' />
								Join collaboration session
							</DropdownMenuItem>
						</>
					)}
					{status.type === 'connected' && (
						<>
							<DropdownMenuItem onClick={disconnect}>
								<Icon icon='RadioTower' />
								Leave collaboration session
							</DropdownMenuItem>
							<DropdownMenuItem onClick={copySessionCode}>
								<Icon icon='Copy' />
								Copy session code
								<DropdownMenuShortcut>
									{formatOTP(status.roomName.replace('microflow-', ''))}
								</DropdownMenuShortcut>
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}
