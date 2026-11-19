// The browser adapter of the broker transport, against a stand-in for mqtt.js.
// (The desktop adapter is three IPC commands and a host event; it needs the
// desktop app to say anything worth asserting.)

import { beforeEach, describe, expect, it, mock } from "bun:test";

import { useMqttBrokerStore, type MqttBrokerConfig } from "@/cloud/mqtt-broker";
import { MQTT5_REQUIRED } from "@/cloud/mqtt-refusal";

import type { BrokerMessage } from "./broker-console-session";

type Handler = (...args: unknown[]) => void;
const handlers: Record<string, Handler> = {};
const calls: string[] = [];
const fakeClient = {
  connected: true,
  on: (event: string, handler: Handler) => {
    handlers[event] = handler;
  },
  subscribe: (topic: string, cb: (e?: Error | null) => void) => {
    calls.push(`sub:${topic}`);
    cb(null);
  },
  unsubscribe: (topic: string, cb: (e?: Error | null) => void) => {
    calls.push(`unsub:${topic}`);
    cb(null);
  },
  publish: (topic: string, payload: string) => calls.push(`pub:${topic}:${payload}`),
  end: () => calls.push("end"),
};
mock.module("mqtt", () => ({
  default: {
    // mqtt.js parses the URL when it connects, and throws on one it cannot read.
    connect: (url: string) => {
      if (/\s/.test(url.trim())) throw new SyntaxError(`Invalid URL: ${url}`);
      return fakeClient;
    },
  },
}));

const { hostBrokerTransport } = await import("./broker-transport");

const broker: MqttBrokerConfig = { id: "b1", name: "public", url: "wss://example/mqtt", isDefault: true };
const status = () => useMqttBrokerStore.getState().statuses.b1;

beforeEach(() => {
  calls.length = 0;
  fakeClient.connected = true;
  useMqttBrokerStore.setState({ brokers: [broker], statuses: {}, problems: {} });
});

describe("the browser broker transport", () => {
  it("subscribes, publishes, and delivers inbound payloads as text under the broker's id", async () => {
    const seen: BrokerMessage[] = [];
    const link = hostBrokerTransport().open(broker, (message) => seen.push(message));

    expect(await link?.subscribe("test/#")).toBe(true);
    // A wildcard subscription's inbound topic never equals the filter — the
    // single-callback fan-out is the whole reason this isn't BrokerConnections.
    handlers.message?.("test/one", new TextEncoder().encode("hello"));
    expect(await link?.publish("test/message", "hi")).toBe(true);
    expect(await link?.unsubscribe("test/#")).toBe(true);
    link?.close();

    expect(seen).toEqual([{ brokerId: "b1", topic: "test/one", payload: "hello" }]);
    expect(calls).toEqual(["sub:test/#", "pub:test/message:hi", "unsub:test/#", "end"]);
  });

  it("keeps the broker's status in the store, which is what the rail's dot shows", () => {
    hostBrokerTransport().open(broker, () => {});
    expect(status()).toBe("connecting");

    handlers.connect?.();
    expect(status()).toBe("connected");
    handlers.error?.();
    expect(status()).toBe("error");
    handlers.close?.();
    expect(status()).toBe("disconnected");
  });

  it("says why a broker refused the connection for its protocol version, until it connects", () => {
    const problem = () => useMqttBrokerStore.getState().problems.b1;
    hostBrokerTransport().open(broker, () => {});

    // A broker that speaks only MQTT 3.1.1 answers with its own CONNACK, which
    // `mqtt.js` emits like this (`mqtt-refusal.test.ts` has the real one), and
    // closes the connection.
    handlers.error?.(
      Object.assign(new Error("Connection refused: Unacceptable protocol version"), { code: 1 }),
    );
    handlers.close?.();
    expect([status(), problem()]).toEqual(["error", MQTT5_REQUIRED]);

    handlers.connect?.();
    expect([status(), problem()]).toEqual(["connected", undefined]);

    // Any other failure is an error with nothing more to say.
    handlers.error?.(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    expect([status(), problem()]).toEqual(["error", undefined]);
    handlers.close?.();
    expect(status()).toBe("disconnected");
  });

  it("refuses to publish while the connection is down", async () => {
    const link = hostBrokerTransport().open(broker, () => {});
    fakeClient.connected = false;

    expect(await link?.publish("test/message", "hi")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("ties a link to what the broker is connected with, because the link is the connection", () => {
    const { linkKey } = hostBrokerTransport();

    expect(linkKey({ ...broker, name: "renamed", isDefault: false })).toBe(linkKey(broker));
    expect(linkKey({ ...broker, url: "wss://example:8081/mqtt" })).not.toBe(linkKey(broker));
    expect(linkKey({ ...broker, id: "b2" })).not.toBe(linkKey(broker));
    // A corrected login is a connection to make again.
    expect(linkKey({ ...broker, username: "ada" })).not.toBe(linkKey(broker));
    expect(linkKey({ ...broker, password: "secret" })).not.toBe(linkKey(broker));
    // An emptied field is no credential, as when it was never filled in.
    expect(linkKey({ ...broker, username: "", password: "" })).toBe(linkKey(broker));
  });

  it("opens nothing for a URL a browser cannot reach", () => {
    const transport = hostBrokerTransport();

    // A URL settles as far as it was typed when the typing pauses.
    expect(transport.open({ ...broker, url: "mqtt://example:1883" }, () => {})).toBeUndefined();
    expect(transport.open({ ...broker, url: "" }, () => {})).toBeUndefined();
    expect(status()).toBeUndefined();
  });

  it("opens nothing for a ws:// URL that is not a URL yet", () => {
    // Typed with a pause, "wss://my broker" can be what has settled.
    expect(hostBrokerTransport().open({ ...broker, url: "wss://my broker" }, () => {})).toBeUndefined();
    expect(status()).toBeUndefined();
  });
});
