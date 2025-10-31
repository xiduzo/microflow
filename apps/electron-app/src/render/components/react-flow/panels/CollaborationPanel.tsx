import { Badge, cn, Icon, toast } from '@microflow/ui';
import { useCollaborationState } from '../../../stores/yjs';
import { formatOTP } from '../../../../common/otp';
import { useCopyCollaborationCode } from '../../../hooks/useCopyCollaborationCode';

export function CollaborationPanel() {
	const { status } = useCollaborationState();
	const { copySessionCode } = useCopyCollaborationCode();

	if (status.type === 'disconnected') return null;

	return (
		<Badge
			onClick={copySessionCode}
			className={cn('', {
				'cursor-copy': status.type === 'connected',
				'animate-pulse': status.type === 'connecting',
			})}
		>
			<Icon
				icon={status.type === 'connected' && status.host ? 'RadioTower' : 'RadioReceiver'}
				className='mr-2'
			/>
			{status.type === 'connected' && formatOTP(status.roomName.replace('microflow-', ''))}
		</Badge>
	);
}
