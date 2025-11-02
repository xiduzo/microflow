import { Badge, cva, Icons } from '@microflow/ui';
import { useBoard } from '../../../stores/board';
import { useLocalStorage } from 'usehooks-ts';
import { AdvancedConfig } from '../../forms/AdvancedSettingsForm';

export function SerialConnectionStatusPanel() {
	const [{ ip }] = useLocalStorage<AdvancedConfig>('advanced-config', {
		ip: undefined,
	});

	const newBoard = useBoard();

	if (newBoard.type === 'error' || newBoard.type === 'warn') {
		return (
			<Badge className={badge({ variant: 'destructive' })}>
				{newBoard.message ?? 'Try to reconnect your microcontroller'}
				<Icons.X size={12} />
			</Badge>
		);
	}

	if (newBoard.type === 'ready' || newBoard.type === 'info') {
		return (
			<Badge className={badge({ variant: 'success' })}>
				Microcontroller connected
				{/* <Icons.FolderSync size={12} /> */}
			</Badge>
		);
	}

	if (newBoard.type === 'connect') {
		return (
			<Badge className={badge({ variant: 'info' })}>
				Connecting to your microcontroller
				<Icons.LoaderCircle size={12} className='animate-spin' />
			</Badge>
		);
	}

	return (
		<Badge className={badge({ variant: 'plain' })}>
			Connect your microcontroller {ip ? `on ${ip}` : 'via USB'}
			{ip ? <Icons.Wifi size={12} /> : <Icons.Usb size={12} />}
		</Badge>
	);
}

const badge = cva('pointer-events-none select-none transition-colors flex items-center gap-2', {
	variants: {
		variant: {
			success: 'bg-green-400 text-green-900',
			destructive: 'bg-red-400 text-red-900',
			warning: 'bg-orange-400 text-orange-900',
			info: 'bg-blue-400 text-blue-900',
			plain: 'dark:bg-muted dark:text-muted-foreground bg-muted-foreground animate-pulse ',
		},
	},
});
