import { Badge, Icons } from '@microflow/ui';
import {
	useAutoCodeUploader,
	useCodeUploader,
} from '../../../hooks/codeUploader';
import { useBoard } from '../../../providers/BoardProvider';
import { FlashFirmata } from './FlashFirmata';

export function SerialConnectionStatus() {
	const { checkResult, uploadResult } = useBoard();
	const uploadCode = useCodeUploader();

	if (checkResult.type === 'error') {
		return <FlashFirmata message={checkResult.message} />;
	}

	if (uploadResult.type === 'error') {
		console.log('uploadResult', uploadResult);
		return (
			<Badge
				className="bg-orange-400 text-orange-900 pointer-events-none"
				onClick={uploadCode}
			>
				Upload failed for unknown reasons
				{/* <Icons.Upload className="ml-2 h-3 w-3" /> */}
			</Badge>
		);
	}

	if (checkResult.type === 'ready') {
		return (
			<Badge className="bg-green-400 text-green-900 pointer-events-none">
				Connected
				<AutoCodeUploader />
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

	if (checkResult.type === 'info' && checkResult.class === 'Connected') {
		return (
			<Badge className="pointer-events-none">
				Validating firmware
				<Icons.Bot className="ml-2 h-3 w-3 animate-pulse" />
			</Badge>
		);
	}

	if (checkResult.type === 'fail') {
		console.log('checkResult', checkResult);
		return (
			<Badge variant="destructive" className="pointer-events-none">
				{checkResult.message ?? 'Unknown error occurred'}
				<Icons.LoaderCircle className="ml-2 h-3 w-3 animate-spin" />
			</Badge>
		);
	}

	return (
		<Badge className="pointer-events-none">
			{checkResult.message?.split('\n')[0].trim() ??
				'Looking for connected device'}
			<Icons.LoaderCircle className="ml-2 h-3 w-3 animate-spin" />
		</Badge>
	);
}

function AutoCodeUploader() {
	useAutoCodeUploader();

	return null;
}
