import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';

type ShareingConnected = { type: 'connected'; tunnelUrl: string };
type SharingDisconnected = { type: 'disconnected' };
type SharingError = { type: 'error'; message: string };
type SharingInitializing = { type: 'initializing' };
type SharingJoined = { type: 'joined'; tunnelUrl: string };

export type SharingState =
	| ShareingConnected
	| SharingDisconnected
	| SharingError
	| SharingInitializing
	| SharingJoined;

type AppState = {
	settingsOpen: string | undefined;
	setSettingsOpen: (settings: string | undefined) => void;
	sharing: SharingState;
	setSharing: (state: SharingState) => void;
};

export const useAppStore = create<AppState>(set => {
	return {
		settingsOpen: undefined,
		setSettingsOpen: (settingsOpen: string | undefined) => {
			set({ settingsOpen });
		},
		sharing: { type: 'disconnected' },
		setSharing: (state: SharingState) => {
			set({ sharing: state });
		},
	};
});

export function useSharing() {
	return useAppStore(
		useShallow(state => ({ sharing: state.sharing, setSharing: state.setSharing })),
	);
}
