import { toast } from '@microflow/ui';
import { Edge, Node, useReactFlow } from '@xyflow/react';
import { useCallback, useEffect } from 'react';
import { useLocalStorage } from 'usehooks-ts';

export function useSaveFlow() {
	const [autoSave, setAutoSave] = useLocalStorage('autoSave', true);
	const { getNodes, getEdges } = useReactFlow();
	const [, setLocalNodes] = useLocalStorage<Node[]>('nodes', []);
	const [, setLocalEdges] = useLocalStorage<Edge[]>('edges', []);

	const saveNodesAndEdges = useCallback(
		(autoSave = false) => {
			setLocalNodes(getNodes());

			setLocalEdges(getEdges());

			if (autoSave) {
				return;
			}

			toast.success('Flow saved');
		},
		[setLocalNodes, getNodes, setLocalEdges, getEdges]
	);

	useEffect(() => {
		if (!autoSave) return;

		const interval = setInterval(() => {
			saveNodesAndEdges(true);
		}, 1000 * 5);

		return () => clearInterval(interval);
	}, [autoSave, saveNodesAndEdges]);

	useEffect(() => {
		window.electron.ipcRenderer.send('ipc-menu', {
			action: 'auto-save',
			args: autoSave,
		});
	}, [autoSave]);

	return { autoSave, setAutoSave, saveNodesAndEdges };
}
