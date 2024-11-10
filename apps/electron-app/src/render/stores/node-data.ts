import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

type NodeData<T extends unknown = unknown> = {
	data: Record<string, T>;
	update: (id: string, data: T) => void;
	clear: () => void;
};

export const useNodeData = create<NodeData>(set => {
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

export const useNodeValue = <T>(id: string, defaultValue: T) =>
	useNodeData(useShallow(state => (state.data[id] as T) ?? defaultValue));

export const useClearNodeData = () => useNodeData(useShallow(state => state.clear));
