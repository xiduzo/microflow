/**
 * Penpot plugin sandbox entry point.
 *
 * Executed by Penpot when the plugin loads. Has access to the global `penpot`
 * object but no DOM. Communicates with the UI iframe via message passing.
 *
 * Mirrors the Figma plugin's main.ts, adapted for the Penpot plugin API.
 */
import {
  type Message,
  type MessageType,
  MSG,
  createMessageRouter,
  sendToUI,
  messages,
} from "../common/messages";
import { getDesignTokens, setDesignToken } from "./handlers/design-tokens";
import { getLocalState, setLocalState } from "./handlers/storage";

// ── Open the UI panel ───────────────────────────────────────────────

// __PLUGIN_HOST__ is replaced at build time by Vite's define config
const url = `${__PLUGIN_HOST__}/ui/index.html`;

penpot.ui.open("Microflow hardware bridge", url, {
  width: 275,
  height: 190,
});

// ── Message router ──────────────────────────────────────────────────

const dispatch = createMessageRouter({
  [MSG.UI_READY]: () => {
    // Acknowledge that the plugin is ready — UI can now request state
    sendToUI(messages.uiReady());

    // Send current theme so the UI can set initial dark/light mode
    sendTheme(penpot.theme);
  },

  [MSG.SHOW_TOAST]: ({ message }) => {
    // Relay toast back to UI (Penpot doesn't have a native notify API like Figma)
    sendToUI(messages.showToast(message));
  },

  [MSG.OPEN_LINK]: (url) => {
    // Penpot has no openExternal API — relay back to UI so it can window.open()
    sendToUI(messages.openLink(url));
  },

  [MSG.GET_LOCAL_STATE]: ({ key, value }) => {
    void getLocalState(key, value);
  },

  [MSG.SET_LOCAL_STATE]: ({ key, value }) => {
    void setLocalState(key, value);
  },

  [MSG.GET_DESIGN_TOKENS]: () => {
    void getDesignTokens();
  },

  [MSG.SET_DESIGN_TOKEN]: ({ path, value }) => {
    void setDesignToken(path, value);
  },
});

// ── Theme forwarding ────────────────────────────────────────────────

/**
 * Sends the current Penpot theme to the UI.
 * Uses a simple message shape since THEME_CHANGE is not part of the
 * typed MSG constants — the UI listens for this separately.
 */
function sendTheme(theme: string) {
  penpot.ui.sendMessage({ type: "THEME_CHANGE", payload: theme });
}

// ── Listen for messages from the UI ─────────────────────────────────

penpot.ui.onMessage<Message<MessageType>>((message) => dispatch(message));

// ── Forward theme changes to the UI ─────────────────────────────────

penpot.on("themechange", (theme) => {
  sendTheme(theme);
});
