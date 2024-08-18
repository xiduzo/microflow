import { Badge, Icons } from '@microflow/ui';
import { useAutoCodeUploader } from '../../../hooks/useCodeUploader';
import { useBoard } from '../../../providers/BoardProvider';

export function SerialConnectionStatus() {
	const { checkResult, uploadResult } = useBoard();
	useAutoCodeUploader();

	if (uploadResult.type === 'error') {
		console.debug('SerialConnectionStatus - uploadResult', uploadResult);
		return (
			<Badge variant="destructive" className="pointer-events-none">
				Upload failed for unknown reasons
				{/* <Icons.Upload className="ml-2 h-3 w-3" /> */}
			</Badge>
		);
	}

	if (checkResult.type === 'ready') {
		return (
			<Badge className="bg-green-400 text-green-900 pointer-events-none">
				Connected
				{uploadResult.type === 'ready' && (
					<Icons.Check className="ml-2 h-3 w-3" />
				)}
				{uploadResult.type === 'info' && (
					<Icons.Zap className="w-2 h-2 ml-2 animate-pulse" />
				)}
				{uploadResult.type === 'close' && (
					<Icons.Loader2 className="w-2 h-2 ml-2 animate-spin" />
				)}
			</Badge>
		);
	}

	if (checkResult.type === 'info') {
		return (
			<Badge className="bg-blue-400 text-blue-900 pointer-events-none">
				Validating micro-controller
				<Icons.Bot className="ml-2 h-3 w-3 animate-pulse" />
			</Badge>
		);
	}

	if (['fail', 'warn', 'errror'].includes(checkResult.type)) {
		console.debug('SerialConnectionStatus - checkResult', checkResult);
		return (
			<Badge variant="destructive" className="pointer-events-none">
				{checkResult.message ?? 'Unknown error occurred'}
			</Badge>
		);
	}

	return (
		<Badge className="bg-muted text-muted-foreground pointer-events-none">
			{checkResult.message?.split('\n')[0].trim() ?? 'Finding micro-controller'}
			<Icons.LoaderCircle className="ml-2 h-3 w-3 animate-spin" />
		</Badge>
	);
}
