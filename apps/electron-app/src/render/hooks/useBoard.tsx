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
		window.electron.ipcRenderer.send('ipc-check-board', { ip });

		return window.electron.ipcRenderer.on<BoardResult>('ipc-check-board', result => {
			if (!result.success) return;
			setBoardResult(result.data);

			switch (result.data.type) {
				case 'error':
				case 'exit':
				case 'fail':
				case 'close':
					result.data.message && toast.warning(result.data.message);
					setTimeout(() => {
						window.electron.ipcRenderer.send('ipc-check-board', { ip });
					}, 1000); // don't force it too much, give the boards some time
					break;
			}
		});
	}, [ip]);
}
