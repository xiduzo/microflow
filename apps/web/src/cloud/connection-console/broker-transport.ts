// The broker console's two transport adapters, one per host.
//
// Desktop drives the native `MqttManager` over IPC (`mqtt_subscribe` /
// `mqtt_unsubscribe` / `mqtt_publish`) and receives inbound messages as
// "mqtt-message" host events. A browser has no such host, so it opens its own
// mqtt.js connection for as long as the link is open — deliberately separate
// from the CloudPerformer's flow connections, so poking a broker by hand can
// never disturb a running flow's subscriptions.

import { listen } from "@tauri-apps/api/event";
import mqtt from "mqtt";

import { isBrowserReachableBroker } from "@/cloud/broker-url";
import { brokerProblem } from "@/cloud/mqtt-refusal";
import {
  useMqttBrokerStore,
  type ConnectionStatus,
  type MqttBrokerConfig,
} from "@/cloud/mqtt-broker";
import { invokeCommand, type MqttMessagePayload } from "@/platform/ipc";
import { isDesktop } from "@/platform/platform";

import type { BrokerTransport } from "./broker-console-session";

/**
 * The desktop host. Its connections are the app's own (`mqtt_sync_brokers`
 * keeps them and reports their status), so a link only adds commands and a
 * listener.
 *
 * The "mqtt-message" event is not the console's alone: the host emits it for
 * every console subscription on any broker, and for flow nodes' subscriptions
 * with an empty `broker_id`. All of it is passed on with the id the host gave.
 */
const desktopBrokerTransport: BrokerTransport = {
  // The commands name the broker by id and the listener depends on no setting,
  // so an edit to the URL is the host's to act on and the link stays.
  linkKey: (broker) => broker.id,

  open(broker, onMessage) {
    const brokerId = broker.id;
    const listening = listen<MqttMessagePayload>("mqtt-message", ({ payload }) =>
      onMessage({ brokerId: payload.broker_id, topic: payload.topic, payload: payload.payload }),
    );
    return {
      subscribe: async (topic) =>
        (await invokeCommand({ type: "mqtt_subscribe", brokerId, topic })).success,
      unsubscribe: async (topic) =>
        (await invokeCommand({ type: "mqtt_unsubscribe", brokerId, topic })).success,
      publish: async (topic, payload) =>
        (await invokeCommand({ type: "mqtt_publish", brokerId, topic, payload })).success,
      close: () => {
        listening.then((unlisten) => unlisten()).catch((error) => console.error(error));
      },
    };
  },
};

/**
 * The browser. One mqtt.js connection per link, and the only source of the
 * broker's status dot on this page, so it writes the status to the store.
 *
 * Unlike `BrokerConnections` (one handler per wiring, routed by topic filter)
 * every inbound message goes to the one callback: the console session decides
 * which of its subscriptions a message belongs to.
 */
const browserBrokerTransport: BrokerTransport = {
  // The link is the connection, and a connection is to a URL with a login. A
  // session is given settled settings, so this changes once per edit, not at
  // every keystroke of a URL or a password.
  linkKey: (broker) =>
    [broker.id, broker.url, broker.username ?? "", broker.password ?? ""].join("\n"),

  open(broker, onMessage) {
    // A URL may settle before it is complete (the typing paused), and
    // `mqtt.connect` throws on anything it cannot read as a URL — "Missing
    // protocol" without a ws(s):// scheme, "Invalid URL" with a space in it.
    if (!isBrowserReachableBroker(broker.url)) return undefined;
    const client = connect(broker);
    if (!client) return undefined;

    const setStatus = (status: ConnectionStatus, problem?: string) =>
      useMqttBrokerStore.getState().setStatus(broker.id, status, problem);

    setStatus("connecting");

    client.on("connect", () => setStatus("connected"));
    client.on("error", (error) => setStatus("error", brokerProblem(error)));
    // A broker closes the connection it refused: the status keeps saying why,
    // until a later attempt connects or fails another way.
    client.on("close", () => {
      if (useMqttBrokerStore.getState().problems[broker.id] === undefined) setStatus("disconnected");
    });
    client.on("message", (topic, payload) =>
      onMessage({ brokerId: broker.id, topic, payload: new TextDecoder().decode(payload) }),
    );

    return {
      subscribe: (topic) =>
        new Promise((resolve) => client.subscribe(topic, (error) => resolve(!error))),
      unsubscribe: (topic) =>
        new Promise((resolve) => client.unsubscribe(topic, (error) => resolve(!error))),
      publish: async (topic, payload) => {
        if (!client.connected) return false;
        client.publish(topic, payload);
        return true;
      },
      close: () => {
        client.end(true);
      },
    };
  },
};

/** A connection to `broker`, or `undefined` when mqtt.js rejects its URL outright. */
function connect(broker: MqttBrokerConfig) {
  try {
    return mqtt.connect(broker.url, {
      // As the flow's connections speak (`cloud/mqtt-client.ts`), so the
      // status dot says whether a flow can reach the broker.
      protocolVersion: 5,
      clientId: `microflow-test-${Math.random().toString(16).slice(2, 10)}`,
      username: broker.username || undefined,
      password: broker.password || undefined,
      reconnectPeriod: 4000,
    });
  } catch {
    return undefined;
  }
}

/** The transport for the host this page runs in. */
export function hostBrokerTransport(): BrokerTransport {
  return isDesktop() ? desktopBrokerTransport : browserBrokerTransport;
}
