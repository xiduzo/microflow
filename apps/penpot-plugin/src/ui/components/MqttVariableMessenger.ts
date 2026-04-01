import { useMqttStore } from "@microflow/mqtt";
import { useEffect, useRef } from "react";
import {
  type DesignToken,
  MSG,
  messages,
  sendToPlugin,
} from "../../common/messages";
import { shortTokenId, fullTokenId } from "../../common/mqtt-topics";
import { useMessageListener } from "../hooks/use-message-listener";

/**
 * Headless component that bridges MQTT messages ↔ Penpot design tokens.
 *
 * Ported from the Figma plugin's MqttVariableMessenger, adapted for
 * Penpot's design token terminology and path-based IDs.
 *
 * - Polls sandbox for token changes at 250ms interval
 * - Publishes token list and individual values to MQTT
 * - Subscribes to inbound set commands and variable requests
 * - Deduplicates publishes using a ref-based value cache
 */
export function MqttVariableMessenger() {
  const { status, publish, subscribe, uniqueId } = useMqttStore();
  const publishedValues = useRef<Map<string, string>>(new Map());
  const knownTokens = useRef<Record<string, { path: string; name: string; type: string }>>({});

  function publishTokens(tokens?: DesignToken[]) {
    if (!tokens) return;

    const newMap: Record<string, { path: string; name: string; type: string }> = {};
    for (const t of tokens) {
      newMap[t.path] = { path: t.path, name: t.name, type: t.type };
    }

    const newJson = JSON.stringify(newMap);
    if (newJson !== JSON.stringify(knownTokens.current)) {
      publish(`microflow/${uniqueId}/penpot/variables`, newJson);
    }
    knownTokens.current = newMap;

    for (const t of tokens) {
      const json = JSON.stringify(t.value);
      if (publishedValues.current.get(t.path) === json) continue;
      publish(
        `microflow/${uniqueId}/penpot/variable/${shortTokenId(t.path)}`,
        json,
      );
      publishedValues.current.set(t.path, json);
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
          JSON.stringify(knownTokens.current),
        );
        publishedValues.current.forEach((value, path) => {
          publish(
            `microflow/${uniqueId}/${app}/variable/${shortTokenId(path)}`,
            value,
          );
        });
      },
    );

    // Handle variable set commands from other clients
    const unsubSet = subscribe(
      `microflow/${uniqueId}/+/variable/+/set`,
      (topic, message) => {
        const shortId = topic.split("/")[4];
        if (!shortId) return;
        const tokenPath = fullTokenId(shortId);

        let value: unknown;
        try {
          value = JSON.parse(message.toString());
        } catch {
          value = message.toString();
        }

        // Prevent echo: mark as published before sending to sandbox
        publishedValues.current.set(tokenPath, JSON.stringify(value));
        sendToPlugin(messages.setDesignToken(tokenPath, value));
      },
    );

    return () => {
      unsubReq();
      unsubSet();
    };
  }, [status, subscribe, publish, uniqueId]);

  // Poll sandbox for token changes
  useMessageListener<DesignToken[]>(MSG.GET_DESIGN_TOKENS, publishTokens, {
    intervalMs: 250,
    sendInitial: true,
  });

  return null;
}
