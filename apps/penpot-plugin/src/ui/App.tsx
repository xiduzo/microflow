import { useEffect } from "react";
import { useMqttStore } from "@microflow/mqtt";
import { MSG, messages, sendToPlugin } from "../common/messages";
import { MqttVariableMessenger } from "./components/MqttVariableMessenger";
import { useMessageListener } from "./hooks/use-message-listener";
import { useNavigation } from "./hooks/use-navigation";
import { Home } from "./pages/Home";
import { MqttSettings } from "./pages/MqttSettings";
import { Variables } from "./pages/Variables";
import { APP_STATE_KEY, type AppState, useAppStore } from "./stores/app";

export function App() {
  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-900 dark:text-white">
      <PluginHandshake />
      <DarkMode />
      <MqttConnection />
      <MqttVariableMessenger />
      <Router />
    </div>
  );
}

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
 * 3. UI reads persisted state directly from localStorage
 */
function PluginHandshake() {
  const { setPluginReady, setAppState } = useAppStore();

  // Step 1: Tell the plugin we're alive
  useEffect(() => {
    sendToPlugin(messages.uiReady());
  }, []);

  // Step 2: Wait for plugin ack, then hydrate from localStorage
  useMessageListener(MSG.UI_READY, () => {
    setPluginReady(true);

    // Read directly from localStorage (Penpot grants access via allow:localstorage)
    try {
      const raw = localStorage.getItem(APP_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && "state" in parsed) {
          setAppState(parsed.state as Partial<AppState>);
        }
      }
    } catch {
      // ignore corrupt localStorage
    }
  });

  // Handle localStorage writes relayed from sandbox
  useMessageListener<{ key: string; value?: unknown }>(
    MSG.SET_LOCAL_STATE,
    (payload) => {
      if (!payload?.key) return;
      try {
        localStorage.setItem(payload.key, JSON.stringify(payload.value));
      } catch {
        // ignore quota errors
      }
    },
  );

  // Handle toast notifications relayed from sandbox
  useMessageListener<{ message: string }>(MSG.SHOW_TOAST, (payload) => {
    // No native toast in Penpot — could use a UI toast library later
    if (payload?.message) console.info("[toast]", payload.message);
  });

  // Handle external links relayed from sandbox
  useMessageListener<string>(MSG.OPEN_LINK, (url) => {
    if (url) window.open(url, "_blank");
  });

  return null;
}

/** Auto-connect MQTT when config is available */
function MqttConnection() {
  const { connect } = useMqttStore();
  const { mqttConfig } = useAppStore();

  useEffect(() => {
    if (!mqttConfig) return;
    connect(mqttConfig, "penpot");
  }, [connect, mqttConfig]);

  return null;
}

/**
 * Sync dark mode with Penpot's theme.
 * Listens for THEME_CHANGE messages from the sandbox (forwarded from penpot.on("themechange")).
 */
function DarkMode() {
  const { setDarkMode } = useAppStore();

  useEffect(() => {
    function handler(event: MessageEvent) {
      if (event.data?.type !== "THEME_CHANGE") return;
      const dark = event.data.payload === "dark";
      setDarkMode(dark);
      document.documentElement.classList.toggle("dark", dark);
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [setDarkMode]);

  return null;
}
