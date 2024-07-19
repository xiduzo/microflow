import { useMqtt } from "@fhb/mqtt/client";
import { useEffect, useRef } from "react";
import { MESSAGE_TYPE } from "../../common/types/Message";
import { useMessageListener } from "../hooks/useMessageListener";

type KnownVariable = Pick<Variable, "name" | "resolvedType" | "id">;

export function MqttVariableMessenger() {
  const { status, publish, subscribe } = useMqtt();
  const publishedVariableValues = useRef<Map<string, any | undefined>>(
    new Map(),
  );
  const knownVariables = useRef<Record<string, KnownVariable>>({}); // <id, name>

  async function publishVariables(variables?: Variable[]) {
    const newVariables =
      variables?.reduce(
        (acc, variable) => {
          acc[variable.id] = {
            id: variable.id,
            name: variable.name,
            resolvedType: variable.resolvedType,
          };
          return acc;
        },
        {} as Record<string, KnownVariable>,
      ) ?? {};

    const newVariablesAsJson = JSON.stringify(newVariables);
    if (newVariablesAsJson !== JSON.stringify(knownVariables.current)) {
      await publish(`fhb/v1/xiduzo/plugin/variables`, newVariablesAsJson);
    }

    knownVariables.current = newVariables;

    variables?.forEach(async (variable) => {
      const current = publishedVariableValues.current.get(variable.id);
      const value = Object.values(variable.valuesByMode)[0];
      const valueAsJson = JSON.stringify(value);
      if (current === valueAsJson) {
        return;
      }

      await publish(
        `fhb/v1/xiduzo/plugin/variable/${variable.id}`,
        JSON.stringify(value),
      );
      publishedVariableValues.current.set(variable.id, valueAsJson);
    });
  }

  useEffect(() => {
    if (status !== "connected") return;

    subscribe("fhb/v1/xiduzo/+/variables/request", (topic) => {
      console.log("Received request for variables", topic);
      const app = topic.split("/")[3];
      publish(
        `fhb/v1/xiduzo/${app}/variables/response`,
        JSON.stringify(knownVariables.current),
      );
      publishedVariableValues.current.forEach((value, id) => {
        publish(`fhb/v1/xiduzo/${app}/variable/${id}`, value);
      });
    });
  }, [status, subscribe, publish]);

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
