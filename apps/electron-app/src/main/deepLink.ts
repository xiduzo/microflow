import { BrowserWindow } from 'electron';
import logger from 'electron-log/node';

export function handleDeepLink(mainWindow: BrowserWindow, link: string) {
	const regex = new RegExp(
		/^(?:mfs|microflow-studio):\/\/(VariableID(?::|%3A)\d+(?::|%3A)\d+)\/(\S+)$/,
	);
	const match = regex.exec(link);
	logger.debug('Received deep link', { link, match });

	if (!match?.length) {
		return;
	}

	const [_link, variableId, value] = match;

	mainWindow.webContents.send(
		'ipc-deep-link',
		'figma',
		decodeURIComponent(variableId),
		decodeURIComponent(value),
	);
}
