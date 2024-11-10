import { useEffect } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { BoardResult } from '../../common/types';
import { useCelebration } from '../providers/CelebrationProvider';
import { useBoardResult, useBoardStore } from '../stores/board';

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

export const useCheckBoard = () => {
	const { setBoardResult } = useBoardStore();

	useEffect(() => {
		window.electron.ipcRenderer.send('ipc-check-board');

		return window.electron.ipcRenderer.on('ipc-check-board', (result: BoardResult) => {
			setBoardResult(result);

			switch (result.type) {
				case 'exit':
				case 'fail':
				case 'close':
					setTimeout(() => {
						window.electron.ipcRenderer.send('ipc-check-board');
					}, 1000); // don't force it too much, give the boards some time
					break;
			}
		});
	}, []);
};
