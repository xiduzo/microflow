import { useCopyToClipboard } from 'usehooks-ts';
import { formatOTP } from '../../common/otp';
import { useCollaborationState } from '../stores/yjs';
import { toast } from '@ui/index';

export function useCopyCollaborationCode() {
	const { status } = useCollaborationState();
	const [, copyToClipboard] = useCopyToClipboard();

	async function copySessionCode() {
		if (status.type !== 'connected') return;
		await copyToClipboard(status.roomName.replace('microflow-', ''));
		toast.success('Session code copied to clipboard', {
			description: formatOTP(status.roomName.replace('microflow-', '')),
		});
	}

	return { copySessionCode };
}
