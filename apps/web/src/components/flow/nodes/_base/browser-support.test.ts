import { describe, expect, it, mock, afterEach } from "bun:test";

const isDesktop = mock(() => false);
mock.module("@/lib/platform", () => ({ isDesktop }));
const isWebSerialSupported = mock(() => true);
mock.module("@/lib/firmata/web-serial", () => ({ isWebSerialSupported }));

const { browserLimitation, isBrowserReachableBroker } = await import("./browser-support");

afterEach(() => {
  isDesktop.mockReturnValue(false);
  isWebSerialSupported.mockReturnValue(true);
});

describe("browserLimitation", () => {
  it("flags pin-driving nodes only when the browser has no Web Serial", () => {
    expect(browserLimitation("Led")).toBeUndefined();
    isWebSerialSupported.mockReturnValue(false);
    expect(browserLimitation("Led")).toContain("Web Serial");
    // …and leaves software-only nodes alone even then.
    expect(browserLimitation("Counter")).toBeUndefined();
  });

  it("never flags anything on desktop", () => {
    isDesktop.mockReturnValue(true);
    isWebSerialSupported.mockReturnValue(false);
    expect(browserLimitation("Led")).toBeUndefined();
    expect(browserLimitation("Midi")).toBeUndefined();
  });

  it("leaves unaffected node types alone", () => {
    expect(browserLimitation("Counter")).toBeUndefined();
    expect(browserLimitation(undefined)).toBeUndefined();
    // Hotkey works in both hosts — the browser dispatches into the wasm runtime.
    expect(browserLimitation("Hotkey")).toBeUndefined();
  });

  it("only flags Midi when the browser has no Web MIDI", () => {
    const nav = globalThis.navigator as unknown as { requestMIDIAccess?: unknown };
    const original = nav.requestMIDIAccess;

    nav.requestMIDIAccess = () => Promise.resolve({});
    expect(browserLimitation("Midi")).toBeUndefined();

    delete nav.requestMIDIAccess;
    expect(browserLimitation("Midi")).toContain("Web MIDI");

    if (original !== undefined) nav.requestMIDIAccess = original;
  });
});

describe("isBrowserReachableBroker", () => {
  it("accepts only MQTT-over-WebSocket URLs", () => {
    expect(isBrowserReachableBroker("ws://localhost:9001")).toBe(true);
    expect(isBrowserReachableBroker(" WSS://broker.example/mqtt ")).toBe(true);
    expect(isBrowserReachableBroker("mqtt://broker.example:1883")).toBe(false);
    expect(isBrowserReachableBroker("broker.example")).toBe(false);
  });
});
