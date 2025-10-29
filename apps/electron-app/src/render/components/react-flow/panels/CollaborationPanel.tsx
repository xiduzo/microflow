import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Badge,
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
import { JoinCollaborationDialog } from './JoinCollaborationDialog';
import { useCopyToClipboard } from 'usehooks-ts';
import { generateOTP, formatOTP } from '../../../../common/otp';
import { useAppStore } from '../../../stores/app';

export function CollaborationPanel() {
	const { status } = useCollaborationState();
	const [, copyToClipboard] = useCopyToClipboard();

	async function copySessionCode() {
		if (status.type !== 'connected') return;
		await copyToClipboard(status.roomName.replace('microflow-', ''));
		toast.success('Session code copied to clipboard', {
			description: formatOTP(status.roomName.replace('microflow-', '')),
		});
	}

	if (status.type !== 'connected') return null;

	return (
		<Badge onClick={copySessionCode} className='cursor-copy'>
			<Icon icon='Share2' className='mr-2' />
			{formatOTP(status.roomName.replace('microflow-', ''))}
		</Badge>
	);
}
