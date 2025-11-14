import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MqttConfig } from '@microflow/mqtt-provider/client';

export type User = {
	name: string;
	color: string;
};

type Settings = 'board-settings' | 'mqtt-settings' | 'user-settings';

type AppState = {
	settingsOpen?: string;
	setSettingsOpen: (settings?: Settings) => void;
	user: User | null;
	setUser: (user: User | null) => void;
	mqttConfig: Omit<MqttConfig, 'uniqueId'> | null;
	setMqttConfig: (mqttConfig: Omit<MqttConfig, 'uniqueId'> | null) => void;
};

export const useAppStore = create(
	persist<AppState>(
		set => ({
			settingsOpen: undefined,
			setSettingsOpen: (settingsOpen?: Settings) => set({ settingsOpen }),
			user: null,
			setUser: user => {
				set({ user });
			},
			mqttConfig: null,
			setMqttConfig: mqttConfig => set({ mqttConfig }),
		}),
		{ name: 'app-store' }
	)
);
