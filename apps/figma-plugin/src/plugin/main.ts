import { showUI } from "@create-figma-plugin/utilities";
import {
  type Message,
  type MessageType,
  MSG,
  createMessageRouter,
  sendToUI,
  messages,
} from "../common/messages";
import { getLocalValue, setLocalValue } from "./handlers/client-storage";
import {
  deleteVariable,
  getLocalVariables,
  setLocalVariable,
} from "./handlers/variables";

export default function () {
  showUI({ width: 275, height: 190 });

  const dispatch = createMessageRouter({
    [MSG.UI_READY]: () => {
      // Acknowledge that the plugin is ready — UI can now request state
      sendToUI(messages.uiReady());
    },
    [MSG.OPEN_LINK]: (url) => {
      figma.openExternal(url);
    },
    [MSG.SHOW_TOAST]: ({ message, options }) => {
      figma.notify(message, options);
    },
    [MSG.SET_LOCAL_STATE]: ({ key, value }) => {
      void setLocalValue(key, value);
    },
    [MSG.GET_LOCAL_STATE]: ({ key, value }) => {
      void getLocalValue(key, value);
    },
    [MSG.GET_LOCAL_VARIABLES]: () => {
      void getLocalVariables();
    },
    [MSG.SET_LOCAL_VARIABLE]: ({ id, value }) => {
      void setLocalVariable(id, value as VariableValue);
    },
    [MSG.DELETE_VARIABLE]: (id) => {
      void deleteVariable(id);
    },
    [MSG.SET_UI_OPTIONS]: (opts) => {
      if (opts.width && opts.height) {
        figma.ui.resize(opts.width, opts.height);
      }
    },
  });

  figma.ui.onmessage = (message: Message<MessageType>) => dispatch(message);
}
