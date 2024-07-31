import { MqttConfig, MqttProvider } from "@fhb/mqtt/client";
import "@fhb/ui/global.css";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { LOCAL_STORAGE_KEYS } from "../common/types/Message";
import { MqttVariableMessenger } from "./components/MqttVariableMessenger";
import { useLocalStorage } from "./hooks/useLocalStorage";
import "./index.css";
import { Config } from "./pages/config";
import { Home } from "./pages/home";
import { Mqtt } from "./pages/mqtt";
import { Variables } from "./pages/variables";
import { VariablesHelp } from "./pages/variables/help";


const router = createMemoryRouter([
  { path: "/", Component: Home },
  { path: "/mqtt", Component: Mqtt },
  { path: "/config", Component: Config },
  { path: "/variables", Component: Variables },
  { path: "/variables/help", Component: VariablesHelp },
]);

export function App() {
  const [uniqueId] = useLocalStorage(LOCAL_STORAGE_KEYS.TOPIC_UID, {
    initialValue: uniqueNamesGenerator({ dictionaries: [adjectives, animals] })
  });

  const [brokerSettings] = useLocalStorage<MqttConfig | undefined>(LOCAL_STORAGE_KEYS.MQTT_CONNECTION)

  return (
    <section className="dark">
      <MqttProvider appName="plugin" uniqueId={uniqueId} config={brokerSettings}>
        <MqttVariableMessenger />
        <RouterProvider router={router} />
      </MqttProvider>
    </section>
  );
}
