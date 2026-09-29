/** @jsxImportSource preact */
import { render } from "@create-figma-plugin/ui";
import {
  useAppStore,
  useDesignBridge,
  useMqttAutoConnect,
  useNavigation,
  usePluginStartup,
} from "@microflow/design-bridge/react";
import { useEffect } from "preact/hooks";
import { channel, settingsStorage, showToast } from "./channel";
import { Home } from "./pages/Home";
import { MqttSettings } from "./pages/MqttSettings";
import { Variables } from "./pages/Variables";

function onInvalid(name: string, payload: string) {
  showToast(`Received invalid value (${payload}) for variable (${name})`, { error: true });
}

function Plugin() {
  usePluginStartup(channel, settingsStorage);
  useMqttAutoConnect("figma");
  useDarkMode();
  const entries = useDesignBridge("figma", channel, { onInvalid });
  const { page } = useNavigation();

  return (
    <div>
      {page === "mqtt" && <MqttSettings />}
      {page === "variables" && <Variables entries={entries} />}
      {page === "home" && <Home />}
    </div>
  );
}

function useDarkMode() {
  const { setDarkMode } = useAppStore();

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (dark: boolean) => {
      setDarkMode(dark);
      document.body.classList.toggle("dark", dark);
    };
    apply(query.matches);
    const onChange = (event: MediaQueryListEvent) => apply(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [setDarkMode]);
}

export default render(Plugin);
