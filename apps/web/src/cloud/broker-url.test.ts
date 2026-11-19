import { describe, expect, it } from "bun:test";
import { isBrowserReachableBroker } from "./broker-url";

describe("isBrowserReachableBroker", () => {
  it("accepts only MQTT-over-WebSocket URLs", () => {
    expect(isBrowserReachableBroker("ws://localhost:9001")).toBe(true);
    expect(isBrowserReachableBroker(" WSS://broker.example/mqtt ")).toBe(true);
    expect(isBrowserReachableBroker("mqtt://broker.example:1883")).toBe(false);
    expect(isBrowserReachableBroker("broker.example")).toBe(false);
  });

  it("rejects the half-typed URLs the config field produces per keystroke", () => {
    // mqtt.connect throws "Missing protocol" on these, so every connect site
    // must ask first.
    for (const url of ["", " ", "w", "wss:/", "broker.example.com", "mqtt://host"]) {
      expect(isBrowserReachableBroker(url)).toBe(false);
    }
    expect(isBrowserReachableBroker(" wss://broker.example.com:8883/mqtt ")).toBe(true);
    expect(isBrowserReachableBroker("ws://localhost:9001")).toBe(true);
  });
});
