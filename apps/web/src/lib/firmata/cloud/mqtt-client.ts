// Browser MQTT-over-WebSocket connections for the cloud host (ADR-0009 Phase 3).
//
// The desktop's `MqttManager` (rumqttc, native sockets) has no browser analog:
// a browser can only speak MQTT over WS/WSS. This is that analog — one lazily
// created `mqtt.js` client per broker id, reused across publishes/subscribes,
// fanning inbound messages to per-topic handlers (one per topic, matching the
// desktop's single per-topic callback). `url` MUST be a `ws://`/`wss://` endpoint.

import mqtt from "mqtt";

/** The connection half of an `MqttBrokerConfig` — what a client needs. */
export type BrokerConn = {
  id: string;
  url: string;
  username?: string;
  password?: string;
};

/** Invoked for each inbound message on a subscribed topic (exact-match topic). */
export type MqttMessageHandler = (topic: string, payload: Uint8Array) => void;

const randomClientId = (): string => `microflow-web-${Math.random().toString(16).slice(2, 10)}`;

/**
 * The minimal surface of an `mqtt.js` client that {@link BrokerConnections} uses
 * — the seam that makes the cloud path unit-testable: a stub stands in for a real
 * connection (the production client needs a live WS/WSS broker). Only the methods
 * the connections actually call are listed (`on("message"|"error")`, subscribe,
 * unsubscribe, publish, end).
 */
export interface MqttClientLike {
  on(event: "message", handler: (topic: string, payload: Uint8Array) => void): void;
  on(event: "error", handler: (error: unknown) => void): void;
  subscribe(topic: string, callback?: (error?: Error | null) => void): void;
  unsubscribe(topic: string): void;
  publish(topic: string, message: string, opts: { retain: boolean }): void;
  end(force?: boolean): void;
}

/** Creates the {@link MqttClientLike} for a broker. The default wraps
 *  `mqtt.connect`; tests inject a stub so no real broker is needed. */
export interface MqttClientFactory {
  create(conn: BrokerConn): MqttClientLike;
}

/** The production factory: one real `mqtt.js` client per broker, over WS/WSS. */
export const defaultMqttClientFactory: MqttClientFactory = {
  create(conn: BrokerConn): MqttClientLike {
    return mqtt.connect(conn.url, {
      clientId: randomClientId(),
      username: conn.username !== undefined && conn.username.length > 0 ? conn.username : undefined,
      password: conn.password !== undefined && conn.password.length > 0 ? conn.password : undefined,
      reconnectPeriod: 4000,
    });
  },
};

export class BrokerConnections {
  private readonly clients = new Map<string, MqttClientLike>();
  /** brokerId → topic → handler (one handler per topic, like the desktop). */
  private readonly handlers = new Map<string, Map<string, MqttMessageHandler>>();

  /** Inject a stub {@link MqttClientFactory} in tests; production uses the real
   *  `mqtt.connect` wrapper by default so existing callers are unchanged. */
  constructor(private readonly factory: MqttClientFactory = defaultMqttClientFactory) {}

  /** Lazily connect (or reuse) the client for a broker. */
  private client(conn: BrokerConn): MqttClientLike {
    const existing = this.clients.get(conn.id);
    if (existing) return existing;

    const topicHandlers = new Map<string, MqttMessageHandler>();
    this.handlers.set(conn.id, topicHandlers);

    const client = this.factory.create(conn);
    client.on("message", (topic: string, payload: Uint8Array) => {
      topicHandlers.get(topic)?.(topic, new Uint8Array(payload));
    });
    client.on("error", (error: unknown) => {
      console.warn(`[mqtt] broker ${conn.id} error:`, error);
    });
    this.clients.set(conn.id, client);
    return client;
  }

  /** Publish a payload. Our cloud payloads are UTF-8 text bytes, sent as text. */
  publish(conn: BrokerConn, topic: string, payload: Uint8Array, retain: boolean): void {
    this.client(conn).publish(topic, new TextDecoder().decode(payload), { retain });
  }

  /** Subscribe `topic` on the broker, replacing any prior handler for it. */
  subscribe(conn: BrokerConn, topic: string, handler: MqttMessageHandler): void {
    const client = this.client(conn);
    this.handlers.get(conn.id)?.set(topic, handler);
    client.subscribe(topic, (error) => {
      if (error) console.warn(`[mqtt] subscribe ${topic} on ${conn.id} failed:`, error);
    });
  }

  unsubscribe(brokerId: string, topic: string): void {
    this.handlers.get(brokerId)?.delete(topic);
    this.clients.get(brokerId)?.unsubscribe(topic);
  }

  /** End every connection (host teardown). */
  disposeAll(): void {
    for (const client of this.clients.values()) client.end(true);
    this.clients.clear();
    this.handlers.clear();
  }
}
