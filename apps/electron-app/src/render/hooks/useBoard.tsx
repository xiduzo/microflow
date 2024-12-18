import { useEffect } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { BoardResult } from '../../common/types';
import { useCelebration } from '../providers/CelebrationProvider';
import { useBoardResult, useBoardStore } from '../stores/board';
import { AdvancedConfig } from '../components/forms/AdvancedSettingsForm';
import { toast } from '@microflow/ui';

export function useCelebrateFirstUpload() {
	const [isFirstUpload, setIsFirstUpload] = useLocalStorage('isFirstUpload', true);
	const { celebrate } = useCelebration();

	const boardResult = useBoardResult();

	useEffect(() => {
		if (!isFirstUpload) return;
		if (boardResult !== 'ready') return;

		celebrate('Succesfully connected your first microcontroller, happy hacking!');
		setIsFirstUpload(false);
	}, [boardResult, isFirstUpload]);
}

export function useCheckBoard() {
	const { setBoardResult } = useBoardStore();
	const [{ ip }] = useLocalStorage<AdvancedConfig>('advanced-config', {
		ip: undefined,
	});

	useEffect(() => {
		console.debug(`[CHECK] >>>`, { ip });
		window.electron.ipcRenderer.send('ipc-check-board', { ip });
	}, []);

	useEffect(() => {
		return window.electron.ipcRenderer.on<BoardResult>('ipc-check-board', result => {
			console.debug(`[CHECK] <<<`, result);

			if (!result.success) {
				toast.warning(result.error);
				return;
			}

			setBoardResult(result.data);

			const isInfo = result.data.type === 'info';
			const isClose = result.data.type === 'close';
			if (isClose || (isInfo && !result.data.port)) {
				console.debug(`[CHECK] >>>`, { ip });
				window.electron.ipcRenderer.send('ipc-check-board', { ip });
			}
		});
	}, [ip]);
}
