import type { Edge, Node } from '@xyflow/react';
import { dialog } from 'electron';
import * as fs from 'fs';
import { FlowState } from '../common/types';

export async function exportFlow(nodes: Node[], edges: Edge[]) {
	const file = await dialog.showSaveDialog({
		title: 'Save a file',
		filters: [{ name: 'Microflow files', extensions: ['microflow'] }],
	});

	if (file.canceled) {
		return Promise.resolve();
	}

	return new Promise<void>((resolve, reject) => {
		fs.writeFile(
			file.filePath.toString(),
			JSON.stringify({ nodes, edges } satisfies FlowState),
			err => {
				if (err) {
					return reject(err);
				}

				resolve();
			}
		);
	});
}

export async function importFlow(): Promise<FlowState | null> {
	const file = await dialog.showOpenDialog({
		title: 'Open a file',
		filters: [{ name: 'Microflow files', extensions: ['microflow'] }],
	});

	if (file.canceled) {
		return Promise.resolve(null);
	}

	return new Promise<FlowState>((resolve, reject) => {
		fs.readFile(file.filePaths[0], (err, data) => {
			if (err) {
				return reject(err);
			}

			resolve(JSON.parse(data.toString()));
		});
	});
}

export async function selectAudioFiles(): Promise<string[]> {
	const result = await dialog.showOpenDialog({
		title: 'Select Audio Files',
		filters: [
			{ name: 'Audio files', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] },
			{ name: 'All files', extensions: ['*'] },
		],
		properties: ['openFile', 'multiSelections'],
	});

	if (result.canceled || !result.filePaths) {
		return [];
	}

	return result.filePaths;
}

export async function readAudioFile(filePath: string): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		fs.readFile(filePath, (err, data) => {
			if (err) {
				return reject(err);
			}
			resolve(data);
		});
	});
}
