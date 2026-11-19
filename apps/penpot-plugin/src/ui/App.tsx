import { messages } from "@microflow/design-bridge";
import { type Page, useAppStore, useNavigation } from "@microflow/design-bridge/react";
import { useEffect } from "react";
import { channel } from "./channel";
import { Toaster } from "./components/Toast";
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
  const { darkMode } = useAppStore();

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
      {page === "variables" && <Variables />}
      {page === "home" && <Home />}
      <Toaster />
    </div>
  );
}
