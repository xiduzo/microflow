import { showUI } from "@create-figma-plugin/utilities";
import { MSG, type PluginMessage, createMessageRouter, messages } from "@microflow/design-bridge";
import { loadLocalValue } from "./handlers/client-storage";
import { readSnapshot, writeVariable } from "./handlers/variables";

function sendToUI(message: PluginMessage) {
  figma.ui.postMessage(message);
}

export default function () {
  showUI({ width: 275, height: 190 });

  figma.ui.onmessage = createMessageRouter(
    {
      [MSG.UI_READY]: () => {
        sendToUI(messages.uiReady());
      },
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
      [MSG.GET_VARIABLES]: async () => {
        sendToUI(messages.getVariables(await readSnapshot()));
      },
      [MSG.SET_VARIABLE]: ({ id, value }) => writeVariable(id, value),
    },
    (type, error) => {
      console.error(`[plugin] ${type} failed`, error);
      figma.notify(`Error: ${type} failed`, { error: true });
    },
  );
}
