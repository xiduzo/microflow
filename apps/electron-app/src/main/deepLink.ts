import { BrowserWindow } from 'electron';
import logger from 'electron-log/node';

export function handleDeepLink(mainWindow: BrowserWindow, link: string) {
	logger.debug('Received deep link', { link });

	const figmaVariableRegex = new RegExp(
		/^(?:mfs|microflow-studio):\/\/(VariableID(?::|%3A)\d+(?::|%3A)\d+)\/(\S+)$/,
	);
	const figmaVariableMatch = figmaVariableRegex.exec(link);

	if (figmaVariableMatch?.length) {
		const [_link, variableId, value] = figmaVariableMatch;

		mainWindow.webContents.send(
			'ipc-deep-link',
			'figma',
			decodeURIComponent(variableId),
			decodeURIComponent(value),
		);
		return;
	}

	const linkWebRegex = new RegExp(/^(?:mfs|microflow-studio):\/\/link-web$/);
	const linkWebMatch = linkWebRegex.exec(link);

	if (linkWebMatch?.length) {
		mainWindow.webContents.send('ipc-deep-link', 'web');
		return;
	}
}
