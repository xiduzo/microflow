import { create } from "zustand";
import type { MqttConfig } from "@microflow/mqtt";

export type AppState = {
  /** Whether the plugin sandbox has acknowledged our UI_READY signal */
  pluginReady: boolean;
  setPluginReady: (ready: boolean) => void;
  mqttConfig: MqttConfig | null;
  setMqttConfig: (config: MqttConfig | null) => void;
  darkMode: boolean;
  setDarkMode: (dark: boolean) => void;
  setAppState: (partial: Partial<AppState>) => void;
};

export const APP_STATE_KEY = "app-state";

export const useAppStore = create<AppState>((set) => ({
  pluginReady: false,
  setPluginReady: (pluginReady) => set({ pluginReady }),
  mqttConfig: null,
  setMqttConfig: (mqttConfig) => set({ mqttConfig }),
  darkMode: false,
  setDarkMode: (darkMode) => set({ darkMode }),
  setAppState: (partial) => set(partial),
}));
