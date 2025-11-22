import {
	Button,
	Dock,
	DockIcon,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Icon,
	Icons,
	Kbd,
	KbdGroup,
	Separator,
	toast,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from '@microflow/ui';
import { useCollaborationActions, useCollaborationState } from '../../../stores/yjs';
import { useReactFlow } from '@xyflow/react';
import { useAppStore } from '../../../stores/app';
import { useShallow } from 'zustand/shallow';
import { useNewNodeStore } from '../../../stores/new-node';
import { useState } from 'react';
import { JoinCollaborationDialog } from './JoinCollaborationDialog';
import { formatOTP, generateOTP } from '../../../../common/otp';
import { useCopyCollaborationCode } from '../../../hooks/useCopyCollaborationCode';
import { KbdAccelerator } from '../../KeyboardShortcut';

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
				<Tooltip delayDuration={1000}>
					<TooltipTrigger asChild>
						<Button variant='ghost' size='icon' disabled={!canUndo()} onClick={undo}>
							<Icons.Undo />
						</Button>
					</TooltipTrigger>
					<TooltipContent className='flex items-center gap-2'>
						Undo
						<KbdGroup>
							<Kbd>{KbdAccelerator()}</Kbd>
							<Kbd>Z</Kbd>
						</KbdGroup>
					</TooltipContent>
				</Tooltip>
			</DockIcon>
			<DockIcon>
				<Tooltip delayDuration={1000}>
					<TooltipTrigger asChild>
						<Button variant='ghost' size='icon' disabled={!canRedo()} onClick={redo}>
							<Icons.Redo />
						</Button>
					</TooltipTrigger>
					<TooltipContent className='flex items-center gap-2'>
						Redo
						<KbdGroup>
							<Kbd>Shift</Kbd>
							<Kbd>{KbdAccelerator()}</Kbd>
							<Kbd>Z</Kbd>
						</KbdGroup>
					</TooltipContent>
				</Tooltip>
			</DockIcon>
			<Separator orientation='vertical' className='h-full' />
			<DockIcon>
				<Tooltip delayDuration={1000}>
					<TooltipTrigger asChild>
						<Button variant='ghost' size='icon' onClick={() => setOpen(true)}>
							<Icons.Plus />
						</Button>
					</TooltipTrigger>
					<TooltipContent className='flex items-center gap-2'>
						Add node
						<KbdGroup>
							<Kbd>{KbdAccelerator()}</Kbd>
							<Kbd>K</Kbd>
						</KbdGroup>
					</TooltipContent>
				</Tooltip>
			</DockIcon>
			<Separator orientation='vertical' className='h-full' />
			<DockIcon>
				<Tooltip delayDuration={1000}>
					<TooltipTrigger asChild>
						<Button variant='ghost' size='icon' onClick={() => zoomIn({ duration: 150 })}>
							<Icons.ZoomIn />
						</Button>
					</TooltipTrigger>
					<TooltipContent className='flex items-center gap-2'>
						Zoom in
						<KbdGroup>
							<Kbd>{KbdAccelerator()}</Kbd>
							<Kbd>+</Kbd>
						</KbdGroup>
					</TooltipContent>
				</Tooltip>
			</DockIcon>
			<DockIcon>
				<Tooltip delayDuration={1000}>
					<TooltipTrigger asChild>
						<Button variant='ghost' size='icon' onClick={() => zoomOut({ duration: 150 })}>
							<Icons.ZoomOut />
						</Button>
					</TooltipTrigger>
					<TooltipContent className='flex items-center gap-2'>
						Zoom out
						<KbdGroup>
							<Kbd>{KbdAccelerator()}</Kbd>
							<Kbd>-</Kbd>
						</KbdGroup>
					</TooltipContent>
				</Tooltip>
			</DockIcon>
			<DockIcon>
				<Tooltip delayDuration={1000}>
					<TooltipTrigger asChild>
						<Button variant='ghost' size='icon' onClick={() => fitView({ duration: 300 })}>
							<Icons.Fullscreen />
						</Button>
					</TooltipTrigger>
					<TooltipContent className='flex items-center gap-2'>
						Fit view
						<KbdGroup>
							<Kbd>{KbdAccelerator()}</Kbd>
							<Kbd>O</Kbd>
						</KbdGroup>
					</TooltipContent>
				</Tooltip>
			</DockIcon>
		</Dock>
	);
}

function Settings() {
	const [dropDownOpen, setDropDownOpen] = useState(false);
	const { setSettingsOpen } = useAppStore();

	return (
		<DropdownMenu onOpenChange={setDropDownOpen}>
			<DropdownMenuTrigger asChild>
				<Button variant={dropDownOpen ? 'default' : 'ghost'} size='icon'>
					<Icons.Settings />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuItem onClick={() => setSettingsOpen('user-settings')}>
					<Icons.User />
					User settings
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setSettingsOpen('mqtt-settings')}>
					<Icons.RadioTower />
					MQTT settings
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setSettingsOpen('board-settings')}>
					<Icons.Microchip />
					Microcontroller settings
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function Collaboration() {
	const { connect, disconnect } = useCollaborationActions();

	const [joinDialogOpen, setJoinDialogOpen] = useState(false);
	const { status } = useCollaborationState();
	const [dropDownOpen, setDropDownOpen] = useState(false);
	const { copySessionCode } = useCopyCollaborationCode();

	function hostAction() {
		const otpCode = generateOTP();
		connect(otpCode);
		toast.success('Started collaboration session', {
			description: `Session code: ${formatOTP(otpCode)}`,
			action: {
				label: 'Copy code',
				onClick: copySessionCode,
			},
		});
	}

	return (
		<>
			<JoinCollaborationDialog open={joinDialogOpen} onOpenChange={setJoinDialogOpen} />
			<DropdownMenu onOpenChange={setDropDownOpen}>
				<DropdownMenuTrigger asChild>
					<Button variant={dropDownOpen ? 'default' : 'ghost'} size='icon'>
						<Icons.Share2 />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					{status.type !== 'connected' && (
						<>
							<DropdownMenuItem onClick={hostAction}>
								<Icons.RadioTower />
								Start collaboration session
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => setJoinDialogOpen(true)}>
								<Icons.RadioReceiver />
								Join collaboration session
							</DropdownMenuItem>
						</>
					)}
					{status.type === 'connected' && (
						<>
							<DropdownMenuItem onClick={disconnect}>
								<Icons.Unplug />
								Leave collaboration session
							</DropdownMenuItem>
							<DropdownMenuItem onClick={copySessionCode}>
								<Icons.Binary />
								Copy session code
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}
