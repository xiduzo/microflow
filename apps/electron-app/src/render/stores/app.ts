import { create } from 'zustand';

type AppState = {
	settingsOpen: string | undefined;
	setSettingsOpen: (settings: string | undefined) => void;
};

export const useAppStore = create<AppState>(set => {
	return {
		settingsOpen: undefined,
		setSettingsOpen: (settingsOpen: string | undefined) => {
			set({ settingsOpen });
		},
	};
});
