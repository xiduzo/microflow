import { Badge, Icons } from '@microflow/ui';
import { useAutoCodeUploader } from '../../../hooks/useCodeUploader';
import { useBoard } from '../../../providers/BoardProvider';

export function SerialConnectionStatus() {
	const { checkResult, uploadResult } = useBoard();
	useAutoCodeUploader();

	if (uploadResult === 'error') {
		console.debug('SerialConnectionStatus - uploadResult', uploadResult);
		return (
			<Badge variant="destructive" className="pointer-events-none select-none">
				Upload failed for unknown reasons
				{/* <Icons.Upload className="ml-2 h-3 w-3" /> */}
			</Badge>
		);
	}

	if (checkResult === 'ready') {
		if (uploadResult === 'info') {
			return (
				<Badge className="bg-orange-400 text-orange-900 animate-pulse pointer-events-none select-none">
					Uploading your flow
					<Icons.Zap className="ml-2 h-3 w-3" />
				</Badge>
			);
		}

		return (
			<Badge className="bg-green-400 text-green-900 pointer-events-none select-none">
				Microcontroller up to date
				{uploadResult === 'ready' && <Icons.Check className="ml-2 h-3 w-3" />}
				{uploadResult === 'close' && <Icons.TriangleAlert className="w-2 h-2 ml-2" />}
			</Badge>
		);
	}

	if (checkResult === 'info') {
		return (
			<Badge className="bg-blue-400 text-blue-900 pointer-events-none select-none">
				Connecting your microcontroller
				<Icons.LoaderCircle className="ml-2 h-3 w-3 animate-spin" />
			</Badge>
		);
	}

	if (['fail', 'warn', 'errror'].includes(checkResult)) {
		console.debug('SerialConnectionStatus - checkResult', checkResult);
		return (
			<Badge variant="destructive" className="pointer-events-none select-none">
				Unknown error occurred
			</Badge>
		);
	}

	return (
		<Badge className="bg-muted text-muted-foreground pointer-events-none animate-pulse select-none">
			Connect your microcontroller by USB
			<Icons.Usb className="ml-2 h-3 w-3" />
		</Badge>
	);
}
