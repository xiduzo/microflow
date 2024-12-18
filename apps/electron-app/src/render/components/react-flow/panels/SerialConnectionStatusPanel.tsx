import { Badge, Button, cva, Icons, useAutoAnimate } from '@microflow/ui';
import { useBoardResult, useUploadResult } from '../../../stores/board';
import { useLocalStorage } from 'usehooks-ts';
import { AdvancedConfig } from '../../forms/AdvancedSettingsForm';
import {
	useCodeUploader,
	useFirstUpload,
	useHasChangesToUpload,
} from '../../../hooks/useCodeUploader';

export function SerialConnectionStatusPanel() {
	const [animationRef] = useAutoAnimate();
	const [{ ip }] = useLocalStorage<AdvancedConfig>('advanced-config', { ip: undefined });
	const boardResult = useBoardResult();
	const uploadResult = useUploadResult();
	const hasChangesToUpload = useHasChangesToUpload();
	const uploadCode = useCodeUploader();
	useFirstUpload();

	if (uploadResult === 'error') {
		return (
			<Badge variant="destructive" className={badge({ variant: 'destructive' })}>
				Upload failed for unknown reasons
			</Badge>
		);
	}

	if (boardResult === 'ready') {
		if (uploadResult === 'info') {
			return (
				<Badge className={badge({ variant: 'warning' })}>
					Uploading your flow
					<Icons.Zap className="ml-2 h-3 w-3 animate-pulse" />
				</Badge>
			);
		}

		return (
			<section className="flex flex-col gap-3">
				<Badge
					className={badge({
						variant: 'success',
						className: hasChangesToUpload ? 'animate-pulse' : '',
					})}
				>
					Microcontroller in sync with flow
					{uploadResult === 'ready' && <Icons.ChevronsLeftRightEllipsis className="ml-2 h-3 w-3" />}
				</Badge>
				<div ref={animationRef}>
					{hasChangesToUpload && (
						<Button size="sm" variant="link" onClick={uploadCode}>
							Apply changes
						</Button>
					)}
				</div>
			</section>
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
