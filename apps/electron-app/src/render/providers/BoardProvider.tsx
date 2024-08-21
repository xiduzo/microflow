import { toast } from '@microflow/ui';
import {
	createContext,
	PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useState,
} from 'react';
import { BoardCheckResult, Pin, UploadCodeResult } from '../../common/types';

const BoardContext = createContext({
	checkResult: {} as BoardCheckResult,
	uploadResult: {} as UploadCodeResult,
	pins: [] as Pin[],
	uploadCode: (code: string) => {
		console.log('uploading code', code);
	},
});
export const useBoard = () => useContext(BoardContext);

export function BoardProvider({ children }: PropsWithChildren) {
	const [checkResult, setCheckResult] = useState<BoardCheckResult>({
		type: 'exit',
	});
	const [uploadResult, setUploadResult] = useState<UploadCodeResult>({
		type: 'close',
	});

	const [pins, setPins] = useState<Pin[]>([]);

	const uploadCode = useCallback(
		(code: string) => {
			setUploadResult({ type: 'info' });

			// TODO: when the uploads happen too fast in a row
			// we need to already call the `off`
			const off = window.electron.ipcRenderer.on(
				'ipc-upload-code',
				(result: UploadCodeResult) => {
					console.log('upload result', result);
					setUploadResult(result);
					if (result.pins) {
						setPins(result.pins);
					}

					if (result.type !== 'info') {
						off();
					}

					if (result.type === 'error') {
						toast.error(result.message);
					}
				},
			);

			window.electron.ipcRenderer.send(
				'ipc-upload-code',
				code,
				checkResult.port,
			);

			return () => {
				off();
			};
		},
		[checkResult.port],
	);

	useEffect(() => {
		window.electron.ipcRenderer.send('ipc-check-board');

		return window.electron.ipcRenderer.on(
			'ipc-check-board',
			(result: BoardCheckResult) => {
				if (result.type !== 'exit') {
					console.log('check result', result);
				}

				setCheckResult(result);
				if (result.pins) {
					setPins(result.pins);
				}

				switch (result.type) {
					case 'exit':
					case 'fail':
					case 'close':
						console.log('check result', result);
						setTimeout(() => {
							window.electron.ipcRenderer.send('ipc-check-board');
						}, 1000); // don't force it too much, give the boards some time
						break;
				}
			},
		);
	}, []);

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
