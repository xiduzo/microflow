import { useEffect, useRef } from 'react';
import { useBoolean, useLocalStorage } from 'usehooks-ts';
import { BoardCheckResult } from '../../common/types';
import { useCelebration } from '../stores/celebration';
import { useBoardCheckResult, useBoardStore } from '../stores/board';
import { AdvancedConfig } from '../components/forms/AdvancedSettingsForm';
import { toast } from '@microflow/ui';

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
	const firstRender = useRef(false);
	const lastIp = useRef<string | undefined>(undefined);
	const [{ ip }] = useLocalStorage<AdvancedConfig>('advanced-config', {
		ip: undefined,
	});

	useEffect(() => {
		if (firstRender.current && lastIp.current === ip) return;
		firstRender.current = true;
		lastIp.current = ip;
		console.debug(`[CHECK] >>>> <ipc-check-board>`, { ip });
		window.electron.ipcRenderer.send('ipc-check-board', { ip });
	}, [ip]);

	useEffect(() => {
		return window.electron.ipcRenderer.on<BoardCheckResult>('ipc-check-board', result => {
			console.debug(`[CHECK] <<<< <ipc-check-board>`, result);

			setUploadResult({ type: 'info' }); // When we received a check result, we can close the upload result

			if (!result.success) {
				toast.warning(result.error);
				setBoardResult({ type: 'close' });
				return;
			}

			setBoardResult(result.data);

			switch (result.data.type) {
				case 'connect':
					toast.info(result.data.message);
					break;
				case 'close':
					console.debug(`[CHECK] >>>>`, { ip });
					window.electron.ipcRenderer.send('ipc-check-board', { ip });
					break;
				case 'info':
					if (result.data.port) break;
					console.debug(`[CHECK] >>>>`, { ip });
					window.electron.ipcRenderer.send('ipc-check-board', { ip });
					break;
			}
		});
	}, [ip, setUploadResult]);
}
