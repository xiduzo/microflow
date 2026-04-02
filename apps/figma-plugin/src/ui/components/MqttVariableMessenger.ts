import { useMqttStore } from "@microflow/mqtt";
import { useEffect, useRef } from "preact/hooks";
import {
  type FullVariable,
  type PickedVariable,
  MSG,
  messages,
  sendToPlugin,
} from "../../common/messages";
import { shortVarId, fullVarId } from "../../common/mqtt-topics";
import { useMessageListener } from "../hooks/use-message-listener";

/**
 * Headless component that bridges MQTT messages ↔ Figma variables.
 *
 * - Polls Figma sandbox for variable changes every 250ms
 * - Publishes variable list (retained) and individual values via MQTT
 * - Responds to variable requests from other clients
 * - Handles inbound set commands
 * - Resets dedup caches on reconnect so state is always re-published
 */
export function MqttVariableMessenger() {
  const { status, publish, subscribe, uniqueId } = useMqttStore();
  const publishedValues = useRef<Map<string, string>>(new Map());
  const knownVariables = useRef<Record<string, PickedVariable>>({});
  const prevStatus = useRef(status);

  // Reset dedup caches when MQTT reconnects so everything gets re-published
  useEffect(() => {
    if (status === "connected" && prevStatus.current !== "connected") {
      knownVariables.current = {};
      publishedValues.current.clear();
    }
    prevStatus.current = status;
  }, [status]);

  function publishVariables(variables?: FullVariable[]) {
    if (!variables || status !== "connected") return;

    const newVars: Record<string, PickedVariable> = {};
    for (const v of variables) {
      newVars[v.id] = { id: v.id, name: v.name, resolvedType: v.resolvedType };
    }

    const newJson = JSON.stringify(newVars);
    if (newJson !== JSON.stringify(knownVariables.current)) {
      // Retain the variables list so late-joining subscribers get it immediately
      publish(`microflow/${uniqueId}/figma/variables`, newJson, { retain: true });
    }
    knownVariables.current = newVars;

    for (const v of variables) {
      const value = Object.values(v.valuesByMode)[0];
      const json = JSON.stringify(value);
      if (publishedValues.current.get(v.id) === json) continue;

      publish(`microflow/${uniqueId}/figma/variable/${shortVarId(v.id)}`, json);
      publishedValues.current.set(v.id, json);
    }
  }

  // Subscribe to MQTT topics when connected
  useEffect(() => {
    if (status !== "connected") return;

    // Respond to variable requests from other clients
    const unsubReq = subscribe(
      `microflow/${uniqueId}/+/variables/request`,
      (topic) => {
        const app = topic.split("/")[2];
        publish(
          `microflow/${uniqueId}/${app}/variables/response`,
          JSON.stringify(knownVariables.current),
        );
        publishedValues.current.forEach((value, id) => {
          publish(`microflow/${uniqueId}/${app}/variable/${shortVarId(id)}`, value);
        });
      },
    );

    // Handle variable set commands from other clients
    const unsubSet = subscribe(
      `microflow/${uniqueId}/+/variable/+/set`,
      (topic, message) => {
        const shortId = topic.split("/")[4];
        if (!shortId) return;
        const variableId = fullVarId(shortId);

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
