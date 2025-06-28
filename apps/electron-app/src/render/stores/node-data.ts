import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import { useNodeId } from '../components/react-flow/nodes/Node';

type NodeData<T extends unknown = unknown> = {
	data: Record<string, T>;
	update: (id: string, data: T) => void;
	clear: () => void;
};

export const useNodeDataStore = create<NodeData>(set => {
	return {
		data: {},
		clear: () => {
			set({ data: {} });
		},
		update: (id, data) => {
			set(state => {
				return {
					data: {
						...state.data,
						[id]: data,
					},
				};
			});
		},
	};
});

export function useNodeValue<T>(defaultValue: T) {
	// This is a dirty hack to get the id of the current node from the context
	// You should never mix react context with a zustand state
	// But ej, there is always an exception to the rule
	const id = useNodeId();
	return useNodeDataStore(useShallow(state => (state.data[id] as T) ?? defaultValue));
}

export function useClearNodeData() {
	return useNodeDataStore(useShallow(state => state.clear));
}
