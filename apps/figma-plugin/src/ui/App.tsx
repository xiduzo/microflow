import { MqttProvider, useMqtt } from "@fhb/mqtt/client";
import "@fhb/ui/global.css";
import { useRef } from "react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { MESSAGE_TYPE } from "../common/types/Message";
import { useMessageListener } from "./hooks/useMessageListener";
import "./index.css";
import { Home } from "./pages/home";

const router = createMemoryRouter([{ path: "/", Component: Home }]);

export function App() {
  return (
    <section className="dark">
      <MqttProvider appName="plugin">
        <MqttVariableSender />
        <RouterProvider router={router} />
      </MqttProvider>
    </section>
  );
}

function MqttVariableSender() {
  const { publish } = useMqtt();
  const publishedVariableIds = useRef<Set<string>>(new Set());
  const publishedVariableValues = useRef<Map<string, any | undefined>>(
    new Map(),
  );

  async function publishVariables(variables?: Variable[]) {
    if (!variables) return;
    const newVariableIds = new Set(variables.map((variable) => variable.id));

    const addedDiff = new Set(
      [...newVariableIds].filter((x) => !publishedVariableIds.current.has(x)),
    );
    const removedDiff = new Set(
      [...publishedVariableIds.current].filter((x) => !newVariableIds.has(x)),
    );

    if (addedDiff.size || removedDiff.size) {
      await publish("fhb/v1/xiduzo/variables", JSON.stringify(variables));
      publishedVariableIds.current = newVariableIds;
    }

    variables.forEach(async (variable) => {
      const current = publishedVariableValues.current.get(variable.id);
      const value = Object.values(variable.valuesByMode)[0];
      const valueAsJsonString = JSON.stringify(value);
      if (current === valueAsJsonString) {
        return;
      }

      await publish(
        `fhb/v1/xiduzo/variable/${variable.id}/figma`,
        JSON.stringify(value),
      );
      publishedVariableValues.current.set(variable.id, valueAsJsonString);
    });
  }

  useMessageListener<Variable[] | undefined>(
    MESSAGE_TYPE.GET_LOCAL_VARIABLES,
    publishVariables,
    {
      intervalInMs: 500,
      shouldSendInitialMessage: true,
    },
  );

  return null;
}
