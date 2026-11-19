import { showUI } from "@create-figma-plugin/utilities";
import { MSG, type PluginMessage, createSandboxBridge, messages } from "@microflow/design-bridge";
import { loadLocalValue } from "./handlers/client-storage";
import { createFigmaAdapter } from "./variables";

function sendToUI(message: PluginMessage) {
  figma.ui.postMessage(message);
}

export default function () {
  showUI({ width: 275, height: 190 });

  const bridge = createSandboxBridge(
    createFigmaAdapter(figma.variables),
    {
      send: sendToUI,
      reportError: (text, cause) => {
        console.error(`[plugin] ${text}`, cause);
        figma.notify(text, { error: true });
      },
      onFailure: (type, error) => {
        console.error(`[plugin] ${type} failed`, error);
        figma.notify(`Error: ${type} failed`, { error: true });
      },
    },
    {
      [MSG.GET_LOCAL_STATE]: async ({ key, value }) => {
        sendToUI(messages.getLocalState(key, await loadLocalValue(key, value)));
      },
      [MSG.SET_LOCAL_STATE]: async ({ key, value }) => {
        await figma.clientStorage.setAsync(key, value);
      },
      [MSG.SHOW_TOAST]: ({ message, error }) => {
        figma.notify(message, { error });
      },
      [MSG.OPEN_LINK]: (url) => {
        figma.openExternal(url);
      },
      [MSG.RESIZE]: ({ width, height }) => {
        figma.ui.resize(width, height);
      },
    },
  );

  figma.ui.onmessage = bridge.dispatch;
}
