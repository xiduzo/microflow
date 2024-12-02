import { toast } from '@microflow/ui';
import { useReactFlow } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { UploadedCodeMessage } from '../../common/types';
import { useNodeDataStore } from '../stores/node-data';

export function useSignalNodesAndEdges() {
	const { updateNodeData, getEdges, updateEdge } = useReactFlow();
	const { update } = useNodeDataStore();
	const timeouts = useRef<Map<string, NodeJS.Timeout>>(new Map());

	useEffect(() => {
		return window.electron.ipcRenderer.on<UploadedCodeMessage>('ipc-microcontroller', result => {
			if (!result.success) return;

			if (result.data.value instanceof Error) {
				toast.error(result.data.value.message, {
					important: true,
					description: `Error in node ${result.data.nodeId} with handle ${result.data.action}`,
				});
				return;
			}

			update(result.data.nodeId, result.data.value);

			getEdges()
				.filter(
					({ source, sourceHandle }) =>
						source === result.data.nodeId && sourceHandle === result.data.action,
				)
				.map(edge => {
					const timeout = timeouts.current.get(edge.id);
					if (timeout) clearTimeout(timeout);

					updateEdge(edge.id, { animated: true });

					timeouts.current.set(
						edge.id,
						setTimeout(() => {
							updateEdge(edge.id, { animated: false });
						}, 150),
					);
				});
		});
	}, [updateNodeData, getEdges, updateEdge, update]);

	return null;
}
