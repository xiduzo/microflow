// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IpcResponse } from './common/types';

type Channels =
	| 'ipc-check-board'
	| 'ipc-upload-code'
	| 'ipc-microcontroller'
	| 'ipc-external-value'
	| 'ipc-menu'
	| 'ipc-deep-link'
	| 'ipc-export-flow'
	| 'ipc-live-share';

type IpcCallback<Data> = (response: IpcResponse<Data>) => void;
type Listener = (event: IpcRendererEvent, response: IpcResponse<any>) => void;
const listeners = new Map<string, Listener>();

export const electronHandler = {
	ipcRenderer: {
		send<Data>(channel: Channels, data?: Data) {
			console.log('[IPC] <send>', channel, data);
			console.time(`send ${channel}`);
			ipcRenderer.send(channel, data);
			console.timeEnd(`send ${channel}`);
		},
		/**
		 * Only one listener per channel is allowed.
		 *
		 * Adding multiple listeners will overwrite the previous one.
		 */
		on<Data>(channel: Channels, callback: IpcCallback<Data>): () => void {
			console.log('[IPC] <on>', channel);
			const listener = (_event: IpcRendererEvent, response: IpcResponse<Data>) =>
				callback(response);

			const previousListener = listeners.get(channel);
			if (previousListener) {
				ipcRenderer.removeListener(channel, previousListener);
				listeners.delete(channel);
			}

			listeners.set(channel, listener);
			ipcRenderer.on(channel, listener);

			return () => {
				ipcRenderer.removeListener(channel, listener);
			};
		},
		once<Data>(channel: Channels, callback: (response: IpcResponse<Data>) => void) {
			console.log('[IPC] <once>', channel);
			ipcRenderer.once(channel, (_event, args) => callback(args));
		},
	},
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
