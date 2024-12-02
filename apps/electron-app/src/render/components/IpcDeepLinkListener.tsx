import { toast } from '@ui/index';
import { useEffect } from 'react';

export function IpcDeepLinkListener() {
	useEffect(() => {
		return window.electron.ipcRenderer.on<{ from: string }>('ipc-deep-link', result => {
			if (!result.success) return;

			console.log('ipc-deep-link', result);

			switch (result.data.from) {
				case 'web':
					toast.success('Microflow studio successfully linked!');
					break;
				default:
					break;
			}
		});
	}, []);

	return null;
}
