import { toast } from "@ui/index";
import { useEffect } from "react";

export function IpcDeepLinkListener() {
	useEffect(() => {
		return window.electron.ipcRenderer.on('ipc-deep-link', (event, ...args) => {
			console.log('ipc-deep-link', event, args);

			switch (event) {
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
