import { toast } from '@fhb/ui';
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
			setLocalNodes(getNodes().filter(node => node.type !== ''));

			setLocalEdges(
				getEdges().map(edge => {
					edge.animated = false;
					return edge;
				}),
			);

			if (!autoSave) {
				toast.success('Flow saved');
			}
		},
		[setLocalNodes, getNodes, setLocalEdges, getEdges],
	);

	const clearNodesAndEdges = useCallback(() => {
		setLocalNodes([]);
		setLocalEdges([]);

		toast.success('Flow cleared');
	}, [setLocalNodes, setLocalEdges]);

	useEffect(() => {
		if (!autoSave) return;

		const interval = setInterval(() => {
			saveNodesAndEdges(true);
		}, 1000 * 30);

		return () => clearInterval(interval);
	}, [autoSave, saveNodesAndEdges]);

	useEffect(() => {
		window.electron.ipcRenderer.send('ipc-menu', 'auto-save', autoSave);
	}, [autoSave]);

	return { autoSave, setAutoSave, saveNodesAndEdges, clearNodesAndEdges };
}
