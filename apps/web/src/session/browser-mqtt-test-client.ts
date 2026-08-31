// The browser half of the MQTT config page's Test Client.
//
// On desktop the card drives the native `MqttManager` over IPC (`mqtt_subscribe`
// / `mqtt_unsubscribe` / `mqtt_publish`) and receives inbound messages as
// "mqtt-message" events. A browser has no such host, so this opens its own
// short-lived mqtt.js connection for the life of the card — deliberately
// separate from the CloudPerformer's flow connections, so poking a broker by
// hand can never disturb a running flow's subscriptions.
//
// Unlike `BrokerConnections` (exact-topic handlers, one per wiring) this fans
// every inbound message to a single callback: the test client subscribes to
// wildcards like `test/#`, whose inbound topics never equal the filter.

import mqtt from "mqtt";
import type { ConnectionStatus, MqttBrokerConfig } from "@/stores/mqtt-broker";

export type TestClient = {
  /** Resolves false when the broker refuses the subscription. */
  subscribe(topic: string): Promise<boolean>;
  unsubscribe(topic: string): Promise<boolean>;
  publish(topic: string, payload: string): boolean;
  end(): void;
};

export function openTestClient(
  broker: MqttBrokerConfig,
  onMessage: (topic: string, payload: string) => void,
  onStatus: (status: ConnectionStatus) => void,
): TestClient {
  onStatus("connecting");
  const client = mqtt.connect(broker.url, {
    clientId: `microflow-test-${Math.random().toString(16).slice(2, 10)}`,
    username: broker.username || undefined,
    password: broker.password || undefined,
    reconnectPeriod: 4000,
  });

  client.on("connect", () => onStatus("connected"));
  client.on("error", () => onStatus("error"));
  client.on("close", () => onStatus("disconnected"));
  client.on("message", (topic, payload) => onMessage(topic, new TextDecoder().decode(payload)));

  return {
    subscribe: (topic) =>
      new Promise((resolve) => client.subscribe(topic, (error) => resolve(!error))),
    unsubscribe: (topic) =>
      new Promise((resolve) => client.unsubscribe(topic, (error) => resolve(!error))),
    publish: (topic, payload) => {
      if (!client.connected) return false;
      client.publish(topic, payload);
      return true;
    },
    end: () => client.end(true),
  };
}
