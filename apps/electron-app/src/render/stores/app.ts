import { create } from 'zustand';
import { getLocalItem, setLocalItem } from '../../common/local-storage';

export type User = {
	name: string;
};

type AppState = {
	settingsOpen: string | undefined;
	setSettingsOpen: (settings: string | undefined) => void;
	user: User | null;
	setUser: (user: User | null) => void;
};

export const useAppStore = create<AppState>(set => {
	const user = getLocalItem<User | null>('user', null);
	return {
		settingsOpen: undefined,
		setSettingsOpen: (settingsOpen: string | undefined) => set({ settingsOpen }),
		user: user,
		setUser: user => {
			setLocalItem('user', user);
			set({ user });
		},
	};
});
