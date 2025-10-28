import { toast } from '@microflow/ui';
import { useReactFlow } from '@xyflow/react';
import { useEffect } from 'react';
import { UploadedCodeMessage } from '../../common/types';
import { useNodeDataStore } from '../stores/node-data';
import { useSignalActions } from '../stores/signal';

export function useSignalNodesAndEdges() {
	const { getEdges } = useReactFlow();
	const { update } = useNodeDataStore();
	const { addSignal } = useSignalActions();

	useEffect(() => {
		return window.electron.ipcRenderer.on<UploadedCodeMessage>('ipc-microcontroller', result => {
			if (!result.success) return;

			if (result.data.value instanceof Error) {
				toast.error(result.data.value.message, {
					description: `Error in node ${result.data.nodeId} with handle ${result.data.action}`,
					duration: Infinity,
				});
				return;
			}

			update(result.data.nodeId, result.data.value);

			// Find edges connected to the source node and handle
			const connectedEdges = getEdges().filter(
				({ source, sourceHandle }) =>
					source === result.data.nodeId && sourceHandle === result.data.action
			);

			// Add signals to each connected edge
			connectedEdges.forEach(edge => {
				addSignal(edge.id);
			});
		});
	}, [getEdges, update, addSignal]);

	return null;
}
