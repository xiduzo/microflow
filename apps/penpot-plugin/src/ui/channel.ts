import { createWindowTransport } from "@microflow/design-bridge";
import { SETTINGS_KEY, type SettingsStorage, createUiChannel } from "@microflow/design-bridge/react";

export const channel = createUiChannel(createWindowTransport({ wrap: "none" }));

/** Penpot gives the UI iframe its own origin, so it keeps the settings in its own localStorage. */
export const storage: SettingsStorage = {
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
