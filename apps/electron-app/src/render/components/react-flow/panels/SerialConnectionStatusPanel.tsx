import { Badge, cva, Icons } from '@microflow/ui';
import { useBoardCheckResult, useUploadResult } from '../../../stores/board';
import { useLocalStorage } from 'usehooks-ts';
import { AdvancedConfig } from '../../forms/AdvancedSettingsForm';

export function SerialConnectionStatusPanel() {
	const [{ ip }] = useLocalStorage<AdvancedConfig>('advanced-config', { ip: undefined });
	const boardCheckResult = useBoardCheckResult();
	const uploadResult = useUploadResult();

	if (uploadResult === 'error') {
		return (
			<Badge className={badge({ variant: 'destructive' })}>
				Upload failed for unknown reasons
				<Icons.X className="ml-2 h-3 w-3" />
			</Badge>
		);
	}

	if (boardCheckResult === 'ready') {
		if (uploadResult === 'info') {
			return (
				<Badge className={badge({ variant: 'warning' })}>
					Uploading your flow
					<Icons.FileUp className="ml-2 h-3 w-3 animate-pulse" />
				</Badge>
			);
		}

		return (
			<Badge className={badge({ variant: 'success' })}>
				Microcontroller in sync with flow
				<Icons.FolderSync className="ml-2 h-3 w-3" />
			</Badge>
		);
	}

	if (boardCheckResult === 'info') {
		return (
			<Badge className={badge({ variant: 'info' })}>
				Connecting to your microcontroller
				<Icons.LoaderCircle className="ml-2 h-3 w-3 animate-spin" />
			</Badge>
		);
	}

	return (
		<Badge className={badge({ variant: 'plain' })}>
			Connect your microcontroller {ip ? `on ${ip}` : 'via USB'}
			{ip ? <Icons.Wifi className="ml-2 h-3 w-3" /> : <Icons.Usb className="ml-2 h-3 w-3" />}
		</Badge>
	);
}

const badge = cva('pointer-events-none select-none transition-colors', {
	variants: {
		variant: {
			success: 'bg-green-400 text-green-900',
			destructive: 'bg-red-400 text-red-900',
			warning: 'bg-orange-400 text-orange-900',
			info: 'bg-blue-400 text-blue-900',
			plain: 'bg-muted text-muted-foreground animate-pulse ',
		},
	},
});
