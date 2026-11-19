// A broker that speaks only MQTT 3.1.1, as the browser host meets it: the real
// `mqtt.js` client, speaking MQTT 5, against a scripted broker that refuses it
// in each of the three ways such a broker does. And the wording, held to the
// desktop host's.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type mqtt from "mqtt";

import { probeBroker } from "./browser-cloud-probe";
import type { MqttBrokerConfig } from "./mqtt-broker";
import { brokerProblem, MQTT5_REQUIRED } from "./mqtt-refusal";
import { startScriptedBroker, type ScriptedBroker } from "./scripted-broker";

// `connection-console/broker-transport.test.ts` mocks "mqtt" process-wide: the
// module behind the package entry is loaded by its path, which no mock names.
const require = createRequire(import.meta.url);
const realMqtt = require(path.join(path.dirname(require.resolve("mqtt")), "mqtt.js")) as typeof mqtt;

/** `mqtt.connect` on the runtime's own `WebSocket`, as in a browser. */
const connect = ((url: string, options: mqtt.IClientOptions) =>
  realMqtt.connect(url, { ...options, forceNativeWebSocket: true })) as typeof mqtt.connect;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function broker(): ScriptedBroker {
  const started = startScriptedBroker();
  cleanups.push(started.stop);
  return started;
}

const config = (url: string): MqttBrokerConfig => ({ id: "b", name: "Lab", url, isDefault: true });

describe("a broker that speaks only MQTT 3.1.1", () => {
  test("refusing with a 3.1.1 CONNACK, return code 1, is told it needs MQTT 5", async () => {
    const scripted = broker();
    scripted.speakOnly311("connack 3.1.1");

    expect(await probeBroker(config(scripted.url), connect)).toEqual({ status: "error", problem: MQTT5_REQUIRED });
    expect(scripted.packets()).toEqual(["CONNECT refused: connack 3.1.1"]);
  });

  test("refusing with an MQTT 5 CONNACK, reason code 0x84, is told it needs MQTT 5", async () => {
    const scripted = broker();
    scripted.speakOnly311("connack 5");

    expect(await probeBroker(config(scripted.url), connect)).toEqual({ status: "error", problem: MQTT5_REQUIRED });
  });

  test("closing the connection without a CONNACK is an error, with nothing claimed about why", async () => {
    const scripted = broker();
    scripted.speakOnly311("close");

    expect(await probeBroker(config(scripted.url), connect)).toEqual({ status: "error" });
  });

  test("a broker that speaks MQTT 5 is connected to", async () => {
    const scripted = broker();

    expect(await probeBroker(config(scripted.url), connect)).toEqual({ status: "connected" });
  });
});

describe("brokerProblem", () => {
  // The errors as `mqtt.js` emits them: an `ErrorWithReasonCode` with the
  // CONNACK's code. The tests above have the real ones.
  const refused = (code: number, words: string) =>
    Object.assign(new Error(`Connection refused: ${words}`), { code });

  test("reads the two refusals for the protocol version", () => {
    expect(brokerProblem(refused(1, "Unacceptable protocol version"))).toBe(MQTT5_REQUIRED);
    expect(brokerProblem(refused(0x84, "Unsupported Protocol Version"))).toBe(MQTT5_REQUIRED);
  });

  test("claims nothing for any other refusal or failure", () => {
    expect(brokerProblem(refused(0x86, "Bad User Name or Password"))).toBeUndefined();
    expect(brokerProblem(refused(5, "Not authorized"))).toBeUndefined();
    expect(brokerProblem(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBeUndefined();
    expect(brokerProblem(new Error("connack timeout"))).toBeUndefined();
    expect(brokerProblem(undefined)).toBeUndefined();
  });
});

test("the desktop host says the same words", () => {
  const rust = readFileSync(path.join(import.meta.dir, "../../src-tauri/src/mqtt/broker.rs"), "utf8");
  const said = /pub const MQTT5_REQUIRED: &str =\s*"([^"]*)";/.exec(rust)?.[1];

  expect(said).toBe(MQTT5_REQUIRED);
});
