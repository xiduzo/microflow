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
	let localUser = getLocalItem<User | null>('user', null);
	if (!localUser) {
		localUser = { name: getRandomUniqueUserName(), color: '#ffcc00' };
		setLocalItem('user', localUser);
	}
	return {
		settingsOpen: undefined,
		setSettingsOpen: (settingsOpen: string | undefined) => set({ settingsOpen }),
		user: localUser,
		setUser: user => {
			set({ user });
			console.log('[AppStore] setUser', user);
			setLocalItem('user', user);
		},
	};
});
