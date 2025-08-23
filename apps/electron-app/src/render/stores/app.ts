import { create } from 'zustand';
import { getLocalItem, setLocalItem } from '../../common/local-storage';
import { getRandomUniqueUserName } from '../../common/unique';

export type User = {
	name: string;
	color: string;
};

type AppState = {
	settingsOpen: string | undefined;
	setSettingsOpen: (settings: string | undefined) => void;
	user: User | null;
	setUser: (user: User | null) => void;
};

export const useAppStore = create<AppState>(set => {
	let user = getLocalItem<User | null>('user', null);
	if (!user) {
		user = {
			name: getRandomUniqueUserName(),
			color: '#ffcc00', // Default yellow color
		};
		setLocalItem('user', user);
	}
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
