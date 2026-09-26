import { beforeEach, describe, expect, test } from "bun:test";
import { type BridgeMqtt, type BridgeSnapshotEntry, DesignBridge } from "./bridge";
import type { BridgeValue } from "./protocol";

type Published = { topic: string; payload: string; retain: boolean };

/** An in-memory broker: records publishes and routes injected messages to subscribers. */
function fakeMqtt() {
  const published: Published[] = [];
  const subscriptions = new Map<string, (topic: string, payload: string) => void>();
  const mqtt: BridgeMqtt = {
    publish: (topic, payload, options) =>
      published.push({ topic, payload, retain: options?.retain ?? false }),
    subscribe: (filter, onMessage) => {
      subscriptions.set(filter, onMessage);
      return () => subscriptions.delete(filter);
    },
  };
  function receive(topic: string, payload: string) {
    for (const [filter, onMessage] of subscriptions) {
      const f = filter.split("/");
      const t = topic.split("/");
      if (f.length === t.length && f.every((level, i) => level === "+" || level === t[i])) {
        onMessage(topic, payload);
      }
    }
  }
  return { mqtt, published, subscriptions, receive };
}

const brightness: BridgeSnapshotEntry = {
  variable: { id: "VariableID:1:2", name: "brightness", resolvedType: "FLOAT" },
  value: 0.5,
};
const led: BridgeSnapshotEntry = {
  variable: { id: "VariableID:1:3", name: "led", resolvedType: "BOOLEAN" },
  value: false,
};

describe("DesignBridge", () => {
  let broker: ReturnType<typeof fakeMqtt>;
  let writes: Array<{ id: string; value: BridgeValue }>;
  let invalid: string[];
  let bridge: DesignBridge;

  beforeEach(() => {
    broker = fakeMqtt();
    writes = [];
    invalid = [];
    bridge = new DesignBridge({
      tool: "figma",
      uid: "swift_fox",
      mqtt: broker.mqtt,
      write: (id, value) => writes.push({ id, value }),
      onInvalid: (variable, payload) => invalid.push(`${variable.name}:${payload}`),
    });
    bridge.start();
  });

  test("publishes the retained list and each value once", () => {
    bridge.update([brightness, led]);
    bridge.update([brightness, led]);

    expect(broker.published).toEqual([
      {
        topic: "microflow/swift_fox/figma/variables",
        payload: JSON.stringify({
          "VariableID:1:2": brightness.variable,
          "VariableID:1:3": led.variable,
        }),
        retain: true,
      },
      { topic: "microflow/swift_fox/figma/variable/1-2", payload: "0.5", retain: false },
      { topic: "microflow/swift_fox/figma/variable/1-3", payload: "false", retain: false },
    ]);
  });

  test("publishes a changed value", () => {
    bridge.update([brightness]);
    broker.published.length = 0;
    bridge.update([{ ...brightness, value: 0.75 }]);
    expect(broker.published).toEqual([
      { topic: "microflow/swift_fox/figma/variable/1-2", payload: "0.75", retain: false },
    ]);
  });

  test("writes a coerced set and does not echo it", () => {
    bridge.update([brightness, led]);
    broker.published.length = 0;

    broker.receive("microflow/swift_fox/app/variable/1-2/set", '"0.9"');
    broker.receive("microflow/swift_fox/app/variable/1-3/set", "on");
    expect(writes).toEqual([
      { id: "VariableID:1:2", value: 0.9 },
      { id: "VariableID:1:3", value: true },
    ]);

    bridge.update([
      { ...brightness, value: 0.9 },
      { ...led, value: true },
    ]);
    expect(broker.published).toEqual([]);
  });

  test("ignores sets for IDs it does not own", () => {
    bridge.update([brightness]);
    broker.receive("microflow/swift_fox/app/variable/3f9a2b1c-8d4e/set", "1");
    expect(writes).toEqual([]);
    expect(invalid).toEqual([]);
  });

  test("reports a value that does not fit the type", () => {
    bridge.update([brightness]);
    broker.receive("microflow/swift_fox/app/variable/1-2/set", "abc");
    expect(writes).toEqual([]);
    expect(invalid).toEqual(["brightness:abc"]);
  });

  test("answers a request into the requester's namespace", () => {
    bridge.update([brightness]);
    broker.published.length = 0;
    broker.receive("microflow/swift_fox/app/variables/request", "");
    expect(broker.published.map((p) => p.topic)).toEqual([
      "microflow/swift_fox/app/variables/response",
      "microflow/swift_fox/app/variable/1-2",
    ]);
  });

  test("ignores its own request namespace", () => {
    bridge.update([brightness]);
    broker.published.length = 0;
    broker.receive("microflow/swift_fox/figma/variables/request", "");
    expect(broker.published).toEqual([]);
  });

  test("forgets removed variables and republishes after reset", () => {
    bridge.update([brightness, led]);
    bridge.update([brightness]);
    broker.published.length = 0;
    bridge.reset();
    bridge.update([brightness]);
    expect(broker.published.map((p) => p.topic)).toEqual([
      "microflow/swift_fox/figma/variables",
      "microflow/swift_fox/figma/variable/1-2",
    ]);
  });

  test("stop unsubscribes", () => {
    bridge.stop();
    expect(broker.subscriptions.size).toBe(0);
  });
});
