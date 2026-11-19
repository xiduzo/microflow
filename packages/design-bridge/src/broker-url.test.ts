import { describe, expect, test } from "bun:test";
import { DEFAULT_BROKER_URL, parseBrokerUrl } from "./broker-url";

describe("parseBrokerUrl", () => {
  test.each([
    ["mqtt.example.com", { protocol: "wss", host: "mqtt.example.com", port: 8883, path: "/mqtt" }],
    ["mqtt.example.com:443", { protocol: "wss", host: "mqtt.example.com", port: 443, path: "/mqtt" }],
    ["mqtt.example.com/ws", { protocol: "wss", host: "mqtt.example.com", port: 8883, path: "/ws" }],
    ["mqtt.example.com:443/", { protocol: "wss", host: "mqtt.example.com", port: 443, path: "/mqtt" }],
    ["localhost:9001", { protocol: "wss", host: "localhost", port: 9001, path: "/mqtt" }],
    ["ws://broker:9001", { protocol: "ws", host: "broker", port: 9001, path: "/mqtt" }],
    ["ws://mqtt.example.com", { protocol: "ws", host: "mqtt.example.com", port: 1883, path: "/mqtt" }],
    ["wss://mqtt.example.com/a/b", { protocol: "wss", host: "mqtt.example.com", port: 8883, path: "/a/b" }],
    [DEFAULT_BROKER_URL, { protocol: "wss", host: "test.mosquitto.org", port: 8081, path: "/mqtt" }],
  ] as const)("%s", (input, url) => {
    expect(parseBrokerUrl(input)).toEqual({ ok: true, url });
  });

  test.each([
    ["", "Host is required"],
    ["my broker.example.com", "Host cannot contain spaces"],
    ["broker", "Invalid hostname format"],
    ["mqtt://mqtt.example.com", "Invalid hostname format"],
    ["mqtt.example.com:port", "Invalid hostname format"],
    ["mqtt.example.com:0", "Invalid port: 0. Must be between 1 and 65535"],
    ["wss://mqtt.example.com:70000", "Invalid port: 70000. Must be between 1 and 65535"],
    ["wss://", "Invalid URL. Expected [ws://|wss://]host[:port][/path]"],
    ["wss://user:secret@mqtt.example.com", "Invalid URL. Expected [ws://|wss://]host[:port][/path]"],
    ["wss://[::1]:9001", "Invalid URL. Expected [ws://|wss://]host[:port][/path]"],
  ])("rejects %p: %s", (input, error) => {
    expect(parseBrokerUrl(input)).toEqual({ ok: false, error });
  });
});
