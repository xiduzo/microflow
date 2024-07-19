import { MqttProvider } from "@fhb/mqtt/client";
import "@fhb/ui/global.css";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { MqttVariableMessenger } from "./components/MqttVariableMessenger";
import "./index.css";
import { Home } from "./pages/home";

const router = createMemoryRouter([{ path: "/", Component: Home }]);

export function App() {
  return (
    <section className="dark">
      <MqttProvider appName="plugin">
        <MqttVariableMessenger />
        <RouterProvider router={router} />
      </MqttProvider>
    </section>
  );
}
