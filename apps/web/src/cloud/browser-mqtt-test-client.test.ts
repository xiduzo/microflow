import { describe, expect, it, mock } from "bun:test";

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
mock.module("mqtt", () => ({ default: { connect: () => fakeClient } }));

const { openTestClient } = await import("./browser-mqtt-test-client");

describe("openTestClient", () => {
  it("subscribes, publishes, and decodes inbound payloads to text", async () => {
    const seen: Array<[string, string]> = [];
    const statuses: string[] = [];
    const client = openTestClient(
      { id: "b1", name: "public", url: "wss://example/mqtt", isDefault: true },
      (topic, payload) => seen.push([topic, payload]),
      (status) => statuses.push(status),
    );

    expect(await client.subscribe("test/#")).toBe(true);
    handlers.connect?.();
    // A wildcard subscription's inbound topic never equals the filter — the
    // single-callback fan-out is the whole reason this isn't BrokerConnections.
    handlers.message?.("test/one", new TextEncoder().encode("hello"));
    expect(client.publish("test/message", "hi")).toBe(true);
    client.end();

    expect(seen).toEqual([["test/one", "hello"]]);
    expect(statuses).toEqual(["connecting", "connected"]);
    expect(calls).toEqual(["sub:test/#", "pub:test/message:hi", "end"]);
  });
});
