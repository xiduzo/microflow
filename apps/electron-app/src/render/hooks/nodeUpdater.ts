import { useReactFlow } from '@xyflow/react';
import { useCallback } from 'react';
import { useCodeUploader } from './useCodeUploader';

export function useUpdateNodeData<T extends Record<string, any>>(nodeId: string) {
	const { updateNodeData: internalUpdateNodeData } = useReactFlow();
	const uploadCode = useCodeUploader();

	const updateNodeData = useCallback((data: Partial<T>, updateCode = true) => {
		internalUpdateNodeData(nodeId, data);

		if (!updateCode) {
			return;
		}

		uploadCode();
	}, []);

	return { updateNodeData };
}
