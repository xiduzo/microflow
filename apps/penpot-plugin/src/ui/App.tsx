import { MSG, messages } from "@microflow/design-bridge";
import {
  type Page,
  useAppStore,
  useDesignBridge,
  useMqttAutoConnect,
  useNavigation,
  usePluginStartup,
} from "@microflow/design-bridge/react";
import { useEffect } from "react";
import { channel, storage } from "./channel";
import { Toaster, toast } from "./components/Toast";
import { Home } from "./pages/Home";
import { MqttSettings } from "./pages/MqttSettings";
import { Variables } from "./pages/Variables";

/** Panel size per page, including Penpot's own title bar and padding. */
const PANEL_SIZES: Record<Page, { width: number; height: number }> = {
  home: { width: 300, height: 260 },
  mqtt: { width: 300, height: 580 },
  variables: { width: 320, height: 440 },
};

export function App() {
  const { page } = useNavigation();
  const { darkMode, setDarkMode } = useAppStore();

  usePluginStartup(channel, storage);
  useMqttAutoConnect("penpot");
  const entries = useDesignBridge("penpot", channel, {
    onInvalid: (name, payload) =>
      toast(`Ignored "${truncate(payload)}" for ${name}`, { error: true }),
  });

  channel.useMessage(MSG.THEME, (theme) => setDarkMode(theme === "dark"));
  channel.useMessage(MSG.SHOW_TOAST, ({ message, error }) => toast(message, { error }));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  useEffect(() => {
    const { width, height } = PANEL_SIZES[page];
    channel.send(messages.resize(width, height));
  }, [page]);

  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-900 dark:text-white">
      {page === "mqtt" && <MqttSettings />}
      {page === "variables" && <Variables entries={entries} />}
      {page === "home" && <Home />}
      <Toaster />
    </div>
  );
}

function truncate(text: string, max = 24) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
