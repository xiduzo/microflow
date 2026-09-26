import { MSG, createWindowTransport, messages } from "@microflow/design-bridge";
import {
  SETTINGS_KEY,
  type SettingsStorage,
  createUiChannel,
} from "@microflow/design-bridge/react";

export const channel = createUiChannel(createWindowTransport({ wrap: "pluginMessage" }));

/** Settings live in `figma.clientStorage`, which only the sandbox can reach. */
export const settingsStorage: SettingsStorage = {
  load() {
    const reply = channel.next(MSG.GET_LOCAL_STATE);
    channel.send(messages.getLocalState(SETTINGS_KEY));
    return reply.then(({ value }) => value);
  },
  save(value) {
    channel.send(messages.setLocalState(SETTINGS_KEY, value));
  },
};

export function showToast(message: string, options?: { error?: boolean }) {
  channel.send(messages.showToast(message, options));
}

export function openLink(url: string) {
  channel.send(messages.openLink(url));
}
