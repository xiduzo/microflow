import { toast } from '@microflow/ui';
import {
	createContext,
	PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { BoardCheckResult, Pin, UploadCodeResult } from '../../common/types';
import { useCelebration } from './CelebrationProvider';

const BoardContext = createContext({
	checkResult: 'exit' as BoardCheckResult['type'],
	uploadResult: 'close' as UploadCodeResult['type'],
	pins: [] as Pin[],
	uploadCode: (code: string) => {
		console.log('uploading code', code);
	},
});
export const useBoard = () => useContext(BoardContext);

export function BoardProvider({ children }: PropsWithChildren) {
	const [isFirstUpload, setIsFirstUpload] = useLocalStorage('isFirstUpload', true);
	const { celebrate } = useCelebration();
	const [checkResult, setCheckResult] = useState<BoardCheckResult['type']>('exit');
	const [uploadResult, setUploadResult] = useState<UploadCodeResult['type']>('close');
	const [pins, setPins] = useState<Pin[]>([]);

	const port = useRef<string>(null);

	const uploadCode = useCallback((code: string) => {
		// TODO: why do we need to keep this ref instead uf using the `checkResult.port` state?
		if (!port.current) {
			// toast.error('No board connected');
			return;
		}
		setUploadResult('info');

		// TODO: when the uploads happen too fast in a row
		// we need to already call the `off`
		const off = window.electron.ipcRenderer.on('ipc-upload-code', (result: UploadCodeResult) => {
			setUploadResult(result.type);

			if (result.pins) {
				setPins(result.pins);
			}

			if (result.type !== 'info') {
				off();
			}

			if (result.type === 'error') {
				toast.error(result.message);
			}
		});

		window.electron.ipcRenderer.send('ipc-upload-code', code, port.current);
	}, []);

	useEffect(() => {
		window.electron.ipcRenderer.send('ipc-check-board');

		return window.electron.ipcRenderer.on('ipc-check-board', (result: BoardCheckResult) => {
			setCheckResult(result.type);

			if (result.pins) {
				setPins(result.pins);
			}

			port.current = result.port;

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

	useEffect(() => {
		if (checkResult === 'ready' && isFirstUpload) {
			celebrate('Succesfully connected your first microcontroller, happy hacking!');
			setIsFirstUpload(false);
		}
	}, [checkResult, isFirstUpload]);

	return (
		<BoardContext.Provider
			value={{
				checkResult,
				uploadResult,
				uploadCode,
				pins,
			}}
		>
			{children}
		</BoardContext.Provider>
	);
}
