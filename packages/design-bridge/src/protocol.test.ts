import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/protocol.json";
import { coerce, colorToHex, decodePayload, encodeValue, hexToColor } from "./codec";
import { bridgeIdFromName, isValidBridgeId } from "./pairing";
import {
  type BridgeColor,
  type DesignTool,
  type ResolvedType,
  bridgeUid,
  fromWireId,
  parseTopic,
  toWireId,
  topics,
} from "./protocol";

function expectClose(actual: unknown, expected: unknown) {
  if (typeof expected === "object" && expected !== null) {
    const color = actual as BridgeColor;
    const want = expected as BridgeColor;
    for (const channel of ["r", "g", "b", "a"] as const) {
      expect(color[channel]).toBeCloseTo(want[channel], 3);
    }
    return;
  }
  expect(actual).toEqual(expected);
}

describe("wire IDs", () => {
  test.each(fixture.wireIds)("$id ↔ $wireId", ({ tool, id, wireId }) => {
    expect(toWireId(id)).toBe(wireId);
    expect(fromWireId(tool as DesignTool, wireId)).toBe(id);
  });
});

describe("topics", () => {
  test.each(fixture.topics)("$fn → $topic", ({ fn, args, topic }) => {
    const build = topics[fn as keyof typeof topics] as (...a: string[]) => string;
    expect(build(...args)).toBe(topic);
    expect(parseTopic(topic)).not.toBeNull();
  });

  test.each(fixture.bridgeUids)("bridge uid of $topic", ({ topic, uid }) => {
    expect(bridgeUid(topic) ?? null).toBe(uid);
  });

  test("parses a set topic", () => {
    expect(parseTopic("microflow/swift_fox/app/variable/1-2/set")).toEqual({
      kind: "set",
      uid: "swift_fox",
      client: "app",
      wireId: "1-2",
    });
  });
});

describe("codec", () => {
  test.each(fixture.coerce)("$type ← $payload", ({ type, payload, value }) => {
    expectClose(coerce(type as ResolvedType, decodePayload(payload)), value);
  });

  test.each(fixture.encode)("encode $payload", ({ value, payload }) => {
    expect(JSON.parse(encodeValue(value))).toEqual(JSON.parse(payload));
  });

  test.each(fixture.hex)("$hex ↔ color", ({ hex, color }) => {
    expectClose(hexToColor(hex), color);
    expect(colorToHex(hexToColor(hex)!)).toBe(hex);
  });
});

describe("pairing", () => {
  test.each(fixture.bridgeIds)("$id valid: $valid", ({ id, valid }) => {
    expect(isValidBridgeId(id)).toBe(valid);
  });

  test.each(fixture.bridgeIdsFromNames)("$name → $id", ({ name, id }) => {
    expect(bridgeIdFromName(name)).toBe(id);
  });
});

describe("stored settings", () => {
  test("migrates the old default broker", async () => {
    const { readStoredMqttConfig, DEFAULT_BROKER_URL } = await import("./react");
    const config = readStoredMqttConfig(
      JSON.stringify({ state: { mqttConfig: { url: "test.mosquitto.org", uniqueId: "swift_fox" } } }),
    );
    expect(config).toEqual({
      url: DEFAULT_BROKER_URL,
      uniqueId: "swift_fox",
      username: undefined,
      password: undefined,
    });
  });
});
