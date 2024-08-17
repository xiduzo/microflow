import { toast } from '@microflow/ui';
import { KnownBoard } from 'avrgirl-arduino';
import {
	createContext,
	PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useState,
} from 'react';
import {
	BoardCheckResult,
	BoardFlashResult,
	Pin,
	UploadCodeResult,
} from '../../common/types';

const BoardContext = createContext({
	checkResult: {} as BoardCheckResult,
	flashResult: {} as BoardFlashResult,
	uploadResult: {} as UploadCodeResult,
	pins: [] as Pin[],
	uploadCode: (code: string) => {
		console.log('uploading code', code);
	},
	flashBoard: (board: KnownBoard) => {
		console.log('flashing board', board);
	},
});
export const useBoard = () => useContext(BoardContext);

export function BoardProvider({ children }: PropsWithChildren) {
	const [checkResult, setCheckResult] = useState<BoardCheckResult>({
		type: 'exit',
	});
	const [flashResult, setFlashResult] = useState<BoardFlashResult>({
		type: 'done',
	});
	const [uploadResult, setUploadResult] = useState<UploadCodeResult>({
		type: 'close',
	});
	const [pins, setPins] = useState<Pin[]>([]);

	function flashBoard(board: KnownBoard) {
		window.electron.ipcRenderer.once(
			'ipc-flash-firmata',
			(result: BoardFlashResult) => {
				console.log('flash result', result);
				setFlashResult(result);

				switch (result.type) {
					case 'done':
						window.electron.ipcRenderer.send('ipc-check-board');
						break;
				}
			},
		);
		window.electron.ipcRenderer.send('ipc-flash-firmata', board);
	}

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
						window.electron.ipcRenderer.send('ipc-check-board');
						break;
				}
			},
		);
	}, []);

	return (
		<BoardContext.Provider
			value={{
				checkResult,
				flashResult,
				uploadResult,
				flashBoard,
				uploadCode,
				pins,
			}}
		>
			{children}
		</BoardContext.Provider>
	);
}
