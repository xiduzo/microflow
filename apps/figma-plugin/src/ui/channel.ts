import { MSG, createWindowTransport, messages } from "@microflow/design-bridge";
import { createUiChannel } from "@microflow/design-bridge/react";
import {
  SETTINGS_KEY,
  type SettingsStorage,
  createPluginBridgeSession,
} from "@microflow/design-bridge/session";

const transport = createWindowTransport({ wrap: "pluginMessage" });

export const channel = createUiChannel(transport);

/** Settings live in `figma.clientStorage`, which only the sandbox can reach. */
const settingsStorage: SettingsStorage = {
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

/** The one bridge session of this plugin window. It starts when the UI loads. */
export const session = createPluginBridgeSession({
  tool: "figma",
  sandbox: transport,
  storage: settingsStorage,
  onInvalid: (variable, payload) =>
    showToast(`Received invalid value (${payload}) for variable (${variable.name})`, {
      error: true,
    }),
});
