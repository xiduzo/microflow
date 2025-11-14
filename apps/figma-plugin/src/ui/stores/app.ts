import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { MqttConfig } from '@microflow/mqtt-provider/client';
import { sendMessageToFigma } from '../utils/sendMessageToFigma';
import { GetLocalStateValue, MESSAGE_TYPE, SetLocalStateValue } from '../../common/types/Message';

export type AppState = {
	mqttConfig: MqttConfig | null;
	setMqttConfig: (mqttConfig: MqttConfig | null) => void;
	darkMode: boolean;
	setDarkMode: (darkMode: boolean) => void;
	setAppState: (appState: Partial<AppState>) => void;
};

export const APP_STATE_LOCAL_STORAGE_KEY = 'app-state';
export const useAppStore = create(
	persist<AppState>(
		set => {
			return {
				mqttConfig: null,
				setMqttConfig: mqttConfig => set({ mqttConfig }),
				darkMode: false,
				setDarkMode: darkMode => set({ darkMode }),
				setAppState: appState => set(appState),
			};
		},
		{
			name: APP_STATE_LOCAL_STORAGE_KEY,
			storage: createJSONStorage(() => ({
				getItem: async key => {
					await new Promise(resolve => setTimeout(resolve, 1000));
					sendMessageToFigma(GetLocalStateValue(key));
					return null;
				},
				setItem: (key, value) => {
					return sendMessageToFigma(SetLocalStateValue(key, value));
				},
				removeItem: key => {},
			})),
		}
	)
);
