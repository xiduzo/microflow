import { create } from 'zustand';

type NodeData<T extends unknown = unknown> = {
	data: Record<string, T>;
	update: (id: string, data: T) => void;
};

export const useNodeData = create<NodeData>(set => {
	return {
		data: {},
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

export const useNodeValue = <T>(id: string, defaultValue: T) => {
	return useNodeData(state => (state.data[id] as T) ?? defaultValue);
};
