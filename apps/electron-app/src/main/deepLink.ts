import { BrowserWindow } from 'electron';
import logger from 'electron-log/node';
import { IpcResponse } from '../common/types';

export function handleDeepLink(mainWindow: BrowserWindow, link: string) {
	// const figmaVariableRegex = new RegExp(
	// 	/^(?:mfs|microflow-studio):\/\/(VariableID(?::|%3A)\d+(?::|%3A)\d+)\/(\S+)$/,
	// );
	const figmaVariableRegex = /VariableID%3A(\d+)%3A(\d+)\/(.+)/;

	const data = figmaVariableRegex.exec(link);
	logger.debug('[DEEP LINK] <<<', { link, data });

	if (data) {
		const [, collectionId, variableId, value] = data;

		mainWindow.webContents.send('ipc-deep-link', {
			success: true,
			data: {
				from: 'figma',
				variableId: `VariableID:${collectionId}:${variableId}`,
				value: decodeURIComponent(value),
			},
		} satisfies IpcResponse<unknown>);
		return;
	}

	if (link.endsWith('://link-web')) {
		mainWindow.webContents.send('ipc-deep-link', {
			success: true,
			data: { from: 'web' },
		} satisfies IpcResponse<unknown>);
		return;
	}
}
