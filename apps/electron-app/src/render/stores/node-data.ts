import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

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

export function useNodeValue<T>(id: string, defaultValue: T) {
	return useNodeDataStore(useShallow(state => (state.data[id] as T) ?? defaultValue));
}

export function useClearNodeData() {
	return useNodeDataStore(useShallow(state => state.clear));
}
