/** @jsxImportSource preact */
import { render } from "@create-figma-plugin/ui";
import { useEffect } from "preact/hooks";
import { useMqttStore } from "@microflow/mqtt";
import { MSG, messages, sendToPlugin } from "../common/messages";
import { MqttVariableMessenger } from "./components/MqttVariableMessenger";
import { useMessageListener } from "./hooks/use-message-listener";
import { useNavigation } from "./hooks/use-navigation";
import { Home } from "./pages/Home";
import { MqttSettings } from "./pages/MqttSettings";
import { Variables } from "./pages/Variables";
import { APP_STATE_KEY, type AppState, useAppStore } from "./stores/app";

function Plugin() {
  return (
    <div>
      <PluginHandshake />
      <DarkMode />
      <MqttConnection />
      <MqttVariableMessenger />
      <Router />
    </div>
  );
}

/** Simple state-based router */
function Router() {
  const { page } = useNavigation();

  switch (page) {
    case "mqtt":
      return <MqttSettings />;
    case "variables":
      return <Variables />;
    default:
      return <Home />;
  }
}

/**
 * Handles the plugin ↔ UI handshake and state hydration.
 *
 * Flow:
 * 1. UI sends UI_READY to plugin
 * 2. Plugin responds with UI_READY (ack)
 * 3. UI requests persisted state from clientStorage
 * 4. Plugin responds with GET_LOCAL_STATE containing the data
 *
 * This replaces the fragile 500ms setTimeout hack.
 */
function PluginHandshake() {
  const { setPluginReady, setAppState } = useAppStore();

  // Step 1: Tell the plugin we're alive
  useEffect(() => {
    sendToPlugin(messages.uiReady());
  }, []);

  // Step 2: Wait for plugin ack, then request persisted state
  useMessageListener(MSG.UI_READY, () => {
    setPluginReady(true);
    sendToPlugin(messages.getLocalState(APP_STATE_KEY));
  });

  // Step 3: Hydrate store from persisted state
  useMessageListener<{ key: string; value?: string }>(
    MSG.GET_LOCAL_STATE,
    (payload) => {
      if (payload?.key !== APP_STATE_KEY || !payload.value) return;
      try {
        const parsed =
          typeof payload.value === "string"
            ? JSON.parse(payload.value)
            : payload.value;
        if (parsed && typeof parsed === "object" && "state" in parsed) {
          setAppState(parsed.state as Partial<AppState>);
        }
      } catch {
        // ignore parse errors
      }
    },
  );

  return null;
}

/** Auto-connect MQTT when config is available */
function MqttConnection() {
  const { connect } = useMqttStore();
  const { mqttConfig } = useAppStore();

  useEffect(() => {
    if (!mqttConfig) return;
    connect(mqttConfig, "plugin");
  }, [connect, mqttConfig]);

  return null;
}

/** Sync dark mode with Figma's theme */
function DarkMode() {
  const { setDarkMode } = useAppStore();

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");

    function toggle(dark: boolean) {
      setDarkMode(dark);
      document.body.classList.toggle("dark", dark);
    }

    toggle(mq.matches);
    const handler = (e: MediaQueryListEvent) => toggle(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [setDarkMode]);

  return null;
}

export default render(Plugin);
