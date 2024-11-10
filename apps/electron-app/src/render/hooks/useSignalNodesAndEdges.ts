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
		return window.electron.ipcRenderer.on('ipc-microcontroller', (message: UploadedCodeMessage) => {
			if (message.value instanceof Error) {
				toast.error(message.value.message, {
					important: true,
					description: `Error in node ${message.nodeId} with handle ${message.action}`,
				});
				return;
			}

			update(message.nodeId, message.value);

			getEdges()
				.filter(
					({ source, sourceHandle }) =>
						source === message.nodeId && sourceHandle === message.action,
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
