import { BrowserWindow } from 'electron';
import logger from 'electron-log/node';

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
			from: 'figma',
			variableId: `VariableID:${collectionId}:${variableId}`,
			value: decodeURIComponent(value),
		});
		return;
	}

	if (link.endsWith('://link-web')) {
		mainWindow.webContents.send('ipc-deep-link', { from: 'web' });
		return;
	}
}
