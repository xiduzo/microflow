import { Badge, Button, cva, Icons, useAutoAnimate, VariantProps } from '@microflow/ui';
import { useBoardCheckResult, useUploadResult } from '../../../stores/board';
import { useLocalStorage } from 'usehooks-ts';
import { AdvancedConfig } from '../../forms/AdvancedSettingsForm';
import { useCodeUploader, useHasChangesToUpload } from '../../../hooks/useCodeUploader';
import { useMemo } from 'react';

export function SerialConnectionStatusPanel() {
	const [animationRef] = useAutoAnimate();
	const [{ ip }] = useLocalStorage<AdvancedConfig>('advanced-config', { ip: undefined });
	const boardCheckResult = useBoardCheckResult();
	const uploadResult = useUploadResult();
	const hasChangesToUpload = useHasChangesToUpload();
	const uploadCode = useCodeUploader();

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
					<Icons.Zap className="ml-2 h-3 w-3 animate-pulse" />
				</Badge>
			);
		}

		if (hasChangesToUpload) {
			return (
				<section className="flex flex-col gap-3">
					<Badge className={badge({ variant: 'success', className: 'animate-pulse' })}>
						New changes found to upload
						<Icons.Replace className="ml-2 h-3 w-3" />
					</Badge>
					<div ref={animationRef} className="flex justify-center items-center">
						<Button size="sm" variant="link" onClick={uploadCode}>
							Apply changes
						</Button>
					</div>
				</section>
			);
		}

		return (
			<Badge className={badge({ variant: 'success' })}>
				'Microcontroller in sync with flow'
				<Icons.ChevronsLeftRightEllipsis className="ml-2 h-3 w-3" />
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
