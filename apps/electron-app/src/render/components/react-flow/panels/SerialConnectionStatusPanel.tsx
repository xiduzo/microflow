import { Badge, cva, Icons } from '@microflow/ui';
import { useAutoCodeUploader } from '../../../hooks/useCodeUploader';
import { useBoardResult, useUploadResult } from '../../../stores/board';
import { useLocalStorage } from 'usehooks-ts';
import { AdvancedConfig } from '../../forms/AdvancedSettingsForm';

export function SerialConnectionStatusPanel() {
	const [{ ip }] = useLocalStorage<AdvancedConfig>('advanced-config', { ip: undefined });
	const boardResult = useBoardResult();
	const uploadResult = useUploadResult();
	useAutoCodeUploader();

	if (uploadResult === 'error') {
		return (
			<Badge variant="destructive" className={badge({ variant: 'destructive' })}>
				Upload failed for unknown reasons
				{/* <Icons.Upload className="ml-2 h-3 w-3" /> */}
			</Badge>
		);
	}

	if (boardResult === 'ready') {
		if (uploadResult === 'info' || uploadResult === 'close') {
			return (
				<Badge className={badge({ variant: 'warning' })}>
					Uploading your flow
					<Icons.Zap className="ml-2 h-3 w-3 animate-pulse" />
				</Badge>
			);
		}

		return (
			<Badge className={badge({ variant: 'success' })}>
				Microcontroller in sync with flow
				{uploadResult === 'ready' && <Icons.ChevronsLeftRightEllipsis className="ml-2 h-3 w-3" />}
			</Badge>
		);
	}

	if (boardResult === 'info') {
		return (
			<Badge className={badge({ variant: 'info' })}>
				Connecting to your microcontroller
				<Icons.LoaderCircle className="ml-2 h-3 w-3 animate-spin" />
			</Badge>
		);
	}

	if (['fail', 'warn', 'error'].includes(boardResult)) {
		console.debug('SerialConnectionStatus - checkResult', boardResult);
		return (
			<Badge variant="destructive" className={badge({ variant: 'destructive' })}>
				Unknown error occurred
			</Badge>
		);
	}

	return (
		<Badge className={badge({ variant: 'plain' })}>
			Connect your microcontroller {!!ip ? `on ${ip}` : 'via USB'}
			{!ip && <Icons.Usb className="ml-2 h-3 w-3" />}
			{!!ip && <Icons.Wifi className="ml-2 h-3 w-3" />}
		</Badge>
	);
}

const badge = cva('pointer-events-none select-none', {
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
