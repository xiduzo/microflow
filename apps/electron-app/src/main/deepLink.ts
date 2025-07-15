import { BrowserWindow } from 'electron';
import logger from 'electron-log/node';
import { IpcResponse } from '../common/types';
import { fromBase64 } from '../common/helpers';

export function handleDeepLink(mainWindow: BrowserWindow, link: string) {
	logger.info('[DEEP LINK] recevied deeplink', { link });

	if (link.includes('://link-web')) {
		mainWindow.webContents.send('ipc-deep-link', {
			success: true,
			data: { from: 'web' },
		} satisfies IpcResponse<unknown>);
		return;
	}

	if (link.includes('://share')) {
		// Format of the link: microflow-studio://share?link=...
		const regex = /microflow-studio:\/\/share\?link=(.+)/;
		const match = link.match(regex);
		if (!match) return logger.error('[DEEP LINK] Invalid share link format', { link });
		const [, sharedLink] = match;

		return mainWindow.webContents.send('ipc-deep-link', {
			success: true,
			data: {
				type: 'share',
				tunnelUrl: fromBase64(sharedLink),
			},
		} satisfies IpcResponse<unknown>);
	}

	if (link.includes('://figma')) {
		const regex = /microflow-studio:\/\/figma\?id=VariableID%3A(\d+)%3A(\d+)&value=(.+)/;
		const match = link.match(regex);
		if (!match) return logger.error('[DEEP LINK] Invalid Figma link format', { link });
		const [, collectionId, variableId, value] = match;
		return mainWindow.webContents.send('ipc-deep-link', {
			success: true,
			data: {
				type: 'figma',
				variableId: `VariableID:${collectionId}:${variableId}`,
				value: decodeURIComponent(value),
			},
		} satisfies IpcResponse<unknown>);
	}

	logger.error('[DEEP LINK] Unknown link format', { link });
}
