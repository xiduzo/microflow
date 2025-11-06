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
					description: `Error in node ${result.data.source} with handle ${result.data.action.toString()}`,
					duration: Infinity,
				});
				return;
			}

			update(result.data.source, result.data.value);

			if (!result.data.target) return;

			const connectedEdges = getEdges().filter(({ source, target, sourceHandle }) => {
				const isSource = source === result.data.source && sourceHandle === result.data.action;
				const isTarget = target === result.data.target;
				return isSource && isTarget;
			});

			connectedEdges.forEach(edge => addSignal(edge.id));
		});
	}, [getEdges, update, addSignal]);

	return null;
}
