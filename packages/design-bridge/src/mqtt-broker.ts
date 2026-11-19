/**
 * The production adapter at the broker seam: mqtt.js over a WebSocket, which is
 * the only transport a plugin UI iframe has.
 */
import mqtt from "mqtt";
import type { BrokerConnector } from "./broker";
import { topicMatches } from "./topic-filter";

type Listener = (topic: string, payload: string) => void;

export const mqttBroker: BrokerConnector = ({ url, clientId, username, password, will, onStatus }) => {
  const listeners = new Map<string, Set<Listener>>();
  let ended = false;
  const live = () => !ended && client.connected;
  // Ending the connection rejects what was still in flight; that is not worth a log line.
  const logError = (action: string) => (error: unknown) => {
    if (!ended) console.error(`[bridge] ${action} failed`, error);
  };

  const client = mqtt.connect({
    protocol: url.protocol,
    hostname: url.host,
    port: url.port,
    path: url.path,
    ...(username && { username }),
    ...(password && { password }),
    clientId,
    // The platform's own WebSocket. A plugin iframe has nothing else; outside a
    // browser this keeps mqtt.js on the code path the plugins run.
    forceNativeWebSocket: true,
    // This adapter subscribes again itself, on every `connect`.
    resubscribe: false,
    will,
  });

  client
    .on("connect", () => {
      // Every filter in one SUBSCRIBE packet, before anyone hears that the connection is up.
      const filters = [...listeners.keys()];
      if (filters.length > 0) client.subscribeAsync(filters).catch(logError("subscribe"));
      onStatus("connected");
    })
    .on("reconnect", () => onStatus("connecting"))
    .on("offline", () => onStatus("disconnected"))
    .on("disconnect", () => onStatus("disconnected"))
    .on("close", () => onStatus("disconnected"))
    .on("error", (error) => {
      logError("connection")(error);
      onStatus("disconnected");
    })
    .on("message", (topic, payload) => {
      const text = payload.toString();
      for (const [filter, subscribers] of listeners) {
        if (!topicMatches(filter, topic)) continue;
        for (const subscriber of subscribers) {
          try {
            subscriber(topic, text);
          } catch (error) {
            logError(`handling ${topic}`)(error);
          }
        }
      }
    });

  return {
    publish(topic, payload, options) {
      if (!live()) return;
      client.publishAsync(topic, payload, options).catch(logError("publish"));
    },

    subscribe(filter, onMessage) {
      let subscribers = listeners.get(filter);
      if (!subscribers) {
        subscribers = new Set();
        listeners.set(filter, subscribers);
        if (live()) client.subscribeAsync(filter).catch(logError("subscribe"));
      }
      // A wrapper, so the same function can subscribe twice and end each one apart.
      const subscriber: Listener = (topic, payload) => onMessage(topic, payload);
      subscribers.add(subscriber);

      return () => {
        if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
        listeners.delete(filter);
        if (live()) client.unsubscribeAsync(filter).catch(logError("unsubscribe"));
      };
    },

    end() {
      ended = true;
      client.removeAllListeners();
      // mqtt.js can still emit `error` while it closes; without a listener that throws.
      client.on("error", () => {});
      client.end(true);
    },
  };
};
