import { type PluginMessage, MSG, createSandboxBridge, messages } from "@microflow/design-bridge";
import { createPenpotAdapter } from "./tokens";

function sendToUI(message: PluginMessage) {
  penpot.ui.sendMessage(message);
}

function sendTheme(theme: string) {
  sendToUI(messages.theme(theme === "dark" ? "dark" : "light"));
}

penpot.ui.open("Microflow hardware bridge", "ui/index.html", { width: 300, height: 260 });

const bridge = createSandboxBridge(
  createPenpotAdapter(() => penpot.library.local.tokens),
  {
    send: sendToUI,
    // Penpot has no notification API, so the UI shows the toast.
    reportError: (text, cause) => {
      if (cause !== undefined) console.error(`[microflow] ${text}`, cause);
      sendToUI(messages.showToast(text, { error: true }));
    },
    onFailure: (type, error) => console.error(`[microflow] ${type} failed`, error),
  },
  {
    [MSG.UI_READY]: () => sendTheme(penpot.theme),
    [MSG.RESIZE]: ({ width, height }) => penpot.ui.resize(width, height),
  },
);

penpot.ui.onMessage<unknown>(bridge.dispatch);

penpot.on("themechange", sendTheme);

penpot.on("contentsave", bridge.pushSnapshot);
