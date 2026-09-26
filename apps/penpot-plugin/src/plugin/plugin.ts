import { type PluginMessage, MSG, createMessageRouter, messages } from "@microflow/design-bridge";
import { bridgeSet, snapshot, tokenValue } from "./tokens";

function sendToUI(message: PluginMessage) {
  penpot.ui.sendMessage(message);
}

function sendTheme(theme: string) {
  sendToUI(messages.theme(theme === "dark" ? "dark" : "light"));
}

function sendSnapshot() {
  sendToUI(messages.getVariables(snapshot()));
}

function reportError(text: string, error?: unknown) {
  if (error !== undefined) console.error(`[microflow] ${text}`, error);
  sendToUI(messages.showToast(text, { error: true }));
}

penpot.ui.open("Microflow hardware bridge", "ui/index.html", { width: 300, height: 260 });

const dispatch = createMessageRouter({
  [MSG.UI_READY]: () => {
    sendToUI(messages.uiReady());
    sendTheme(penpot.theme);
  },

  [MSG.GET_VARIABLES]: sendSnapshot,

  [MSG.SET_VARIABLE]: ({ id, value }) => {
    const token = bridgeSet()?.getTokenById(id);
    if (!token) return reportError("That token no longer exists");
    const stored = tokenValue(token, value);
    if (stored === null) return reportError(`${token.name} cannot hold that value`);
    try {
      token.value = stored;
    } catch (error) {
      reportError(`Could not update ${token.name}`, error);
    }
  },

  [MSG.RESIZE]: ({ width, height }) => penpot.ui.resize(width, height),
});

penpot.ui.onMessage<unknown>(dispatch);

penpot.on("themechange", sendTheme);

penpot.on("contentsave", () => {
  try {
    sendSnapshot();
  } catch (error) {
    console.error("[microflow] could not read the tokens", error);
  }
});
