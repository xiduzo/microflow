import { MSG, createWindowTransport } from "@microflow/design-bridge";
import { createUiChannel, useAppStore } from "@microflow/design-bridge/react";
import {
  SETTINGS_KEY,
  type SettingsStorage,
  createPluginBridgeSession,
} from "@microflow/design-bridge/session";
import { toast } from "./components/Toast";

const transport = createWindowTransport({ wrap: "none" });

export const channel = createUiChannel(transport);

// The sandbox sends the theme in reply to the session's hello, and its toasts at
// any time, so both listeners are in place before the session exists.
channel.on(MSG.THEME, (theme) => useAppStore.getState().setDarkMode(theme === "dark"));
channel.on(MSG.SHOW_TOAST, ({ message, error }) => toast(message, { error }));

/** Penpot gives the UI iframe its own origin, so it keeps the settings in its own localStorage. */
const storage: SettingsStorage = {
  async load() {
    try {
      return localStorage.getItem(SETTINGS_KEY);
    } catch {
      return null;
    }
  },
  save(value) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
  },
};

export function openLink(url: string) {
  window.open(url, "_blank", "noopener");
}

/** The one bridge session of this plugin window. It starts when the UI loads. */
export const session = createPluginBridgeSession({
  tool: "penpot",
  sandbox: transport,
  storage,
  onInvalid: (variable, payload) =>
    toast(`Ignored "${truncate(payload)}" for ${variable.name}`, { error: true }),
});

function truncate(text: string, max = 24) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
