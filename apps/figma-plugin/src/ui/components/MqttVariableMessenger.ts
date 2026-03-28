import { useMqttStore } from "@microflow/mqtt";
import { useEffect, useRef } from "preact/hooks";
import {
  type FullVariable,
  type PickedVariable,
  MSG,
  messages,
  sendToPlugin,
} from "../../common/messages";
import { useMessageListener } from "../hooks/use-message-listener";

/**
 * Headless component that bridges MQTT messages ↔ Figma variables.
 *
 * Improvements over prototype:
 * - Poll interval raised from 100ms → 250ms (less CPU, still responsive)
 * - Ref-based dedup to avoid redundant publishes
 * - Cleaner subscription lifecycle
 */
export function MqttVariableMessenger() {
  const { status, publish, subscribe, uniqueId } = useMqttStore();
  const publishedValues = useRef<Map<string, string>>(new Map());
  const knownVariables = useRef<Record<string, PickedVariable>>({});

  function publishVariables(variables?: FullVariable[]) {
    if (!variables) return;

    const newVars: Record<string, PickedVariable> = {};
    for (const v of variables) {
      newVars[v.id] = { id: v.id, name: v.name, resolvedType: v.resolvedType };
    }

    const newJson = JSON.stringify(newVars);
    if (newJson !== JSON.stringify(knownVariables.current)) {
      publish(`microflow/v1/${uniqueId}/plugin/variables`, newJson);
    }
    knownVariables.current = newVars;

    for (const v of variables) {
      const value = Object.values(v.valuesByMode)[0];
      const json = JSON.stringify(value);
      if (publishedValues.current.get(v.id) === json) continue;

      publish(`microflow/v1/${uniqueId}/plugin/variable/${v.id}`, json);
      publishedValues.current.set(v.id, json);
    }
  }

  // Subscribe to MQTT topics when connected
  useEffect(() => {
    if (status !== "connected") return;

    // Respond to variable requests from other clients
    const unsubReq = subscribe(
      `microflow/v1/${uniqueId}/+/variables/request`,
      (topic) => {
        const app = topic.split("/")[3];
        publish(
          `microflow/v1/${uniqueId}/${app}/variables/response`,
          JSON.stringify(knownVariables.current),
        );
        publishedValues.current.forEach((value, id) => {
          publish(`microflow/v1/${uniqueId}/${app}/variable/${id}`, value);
        });
      },
    );

    // Handle variable set commands from other clients
    const unsubSet = subscribe(
      `microflow/v1/${uniqueId}/+/variable/+/set`,
      (topic, message) => {
        const variableId = topic.split("/")[5];
        if (!variableId) return;

        let value: unknown;
        try {
          value = JSON.parse(message.toString());
        } catch {
          value = message.toString();
        }

        // Prevent echo: mark as published before sending to Figma
        publishedValues.current.set(variableId, JSON.stringify(value));
        sendToPlugin(messages.setLocalVariable(variableId, value));
      },
    );

    return () => {
      unsubReq();
      unsubSet();
    };
  }, [status, subscribe, publish, uniqueId]);

  // Poll Figma for variable changes
  useMessageListener<FullVariable[]>(MSG.GET_LOCAL_VARIABLES, publishVariables, {
    intervalMs: 250,
    sendInitial: true,
  });

  return null;
}
