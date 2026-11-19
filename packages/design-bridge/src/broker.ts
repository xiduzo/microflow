/**
 * The seam between the plugin bridge session and an MQTT broker. Two adapters
 * satisfy it: mqtt.js over a WebSocket (`mqtt-broker.ts`, production) and the
 * in-memory broker (`memory-broker.ts`, tests).
 */
import type { BridgeMqtt } from "./bridge";
import type { BrokerUrl } from "./broker-url";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type BrokerMessage = {
  topic: string;
  payload: string;
  retain: boolean;
  qos: 0 | 1 | 2;
};

export type BrokerConnectOptions = {
  url: BrokerUrl;
  clientId: string;
  username?: string;
  password?: string;
  /** The broker publishes this when the connection is lost without a goodbye. */
  will: BrokerMessage;
  /**
   * The connection came up, is retrying, or went down. Never called before
   * `connect` returns, and never after `end`.
   */
  onStatus: (status: ConnectionStatus) => void;
};

/**
 * One connection that reconnects by itself. Subscriptions stay in effect
 * across reconnects; a publish while the connection is down is dropped.
 */
export interface BrokerConnection extends BridgeMqtt {
  /** Drop the connection without a goodbye, so the broker publishes the last will. */
  end(): void;
}

export type BrokerConnector = (options: BrokerConnectOptions) => BrokerConnection;
