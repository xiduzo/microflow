import { create } from 'zustand';

type NewNodeStore = {
	open: boolean;
	setOpen: (open: boolean) => void;
	nodeToAdd: string | null;
	setNodeToAdd: (nodeId: string | null) => void;
};

export const useNewNodeStore = create<NewNodeStore>((set, get) => ({
	open: false,
	setOpen: (open: boolean) => {
		set({ open });
	},
	nodeToAdd: null as string | null,
	setNodeToAdd: (nodeId: string | null) => {
		set({ nodeToAdd: nodeId });

		if (nodeId) set({ open: false });
	},
}));
