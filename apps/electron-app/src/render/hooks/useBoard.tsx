import { useEffect } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { BoardCheckResult } from '../../common/types';
import { useCelebration } from '../providers/CelebrationProvider';
import { useBoardCheckResult, useBoardStore } from '../stores/board';
import { AdvancedConfig } from '../components/forms/AdvancedSettingsForm';
import { toast } from '@microflow/ui';
import { useCodeUploader } from './useCodeUploader';

export function useCelebrateFirstUpload() {
	const [isFirstUpload, setIsFirstUpload] = useLocalStorage('isFirstUpload', true);
	const { celebrate } = useCelebration();

	const boardCheckResult = useBoardCheckResult();

	useEffect(() => {
		if (!isFirstUpload) return;
		if (boardCheckResult !== 'ready') return;

		celebrate('Succesfully connected your first microcontroller, happy hacking!');
		setIsFirstUpload(false);
	}, [boardCheckResult, isFirstUpload]);
}

export function useCheckBoard() {
	const { setBoardResult, setUploadResult } = useBoardStore();
	const uploadCode = useCodeUploader();
	const [{ ip }] = useLocalStorage<AdvancedConfig>('advanced-config', {
		ip: undefined,
	});

	useEffect(() => {
		console.debug(`[CHECK] >>>`, { ip });
		window.electron.ipcRenderer.send('ipc-check-board', { ip });
	}, []);

	useEffect(() => {
		return window.electron.ipcRenderer.on<BoardCheckResult>('ipc-check-board', result => {
			console.debug(`[CHECK] <<<`, result);

			setUploadResult({ type: 'close' }); // When we received a check result, we can close the upload result

			if (!result.success) {
				toast.warning(result.error);
				setBoardResult({ type: 'close' });
				return;
			}

			setBoardResult(result.data);

			switch (result.data.type) {
				case 'close':
					console.debug(`[CHECK] >>>`, { ip });
					window.electron.ipcRenderer.send('ipc-check-board', { ip });
					break;
				case 'info':
					if (result.data.port) break;
					console.debug(`[CHECK] >>>`, { ip });
					window.electron.ipcRenderer.send('ipc-check-board', { ip });
					break;
				case 'ready':
					uploadCode();
					break;
			}
		});
	}, [ip, setUploadResult, uploadCode]);
}
