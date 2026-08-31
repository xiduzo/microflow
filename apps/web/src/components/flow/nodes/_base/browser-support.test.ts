import { describe, expect, it, mock, afterEach } from "bun:test";

const isDesktop = mock(() => false);
mock.module("@/lib/platform", () => ({ isDesktop }));
const isWebSerialSupported = mock(() => true);
mock.module("@/lib/firmata/web-serial", () => ({ isWebSerialSupported }));

const { hostLimitation, isBrowserReachableBroker } = await import("./browser-support");

afterEach(() => {
  isDesktop.mockReturnValue(false);
  isWebSerialSupported.mockReturnValue(true);
});

describe("hostLimitation: node", () => {
  it("flags pin-driving nodes only when the browser has no Web Serial", () => {
    expect(hostLimitation({ kind: "node", type: "Led" })).toBeUndefined();
    isWebSerialSupported.mockReturnValue(false);
    const limitation = hostLimitation({ kind: "node", type: "Led" });
    expect(limitation?.label).toBe("desktop only");
    expect(limitation?.reason).toContain("Web Serial");
    // …and leaves software-only nodes alone even then.
    expect(hostLimitation({ kind: "node", type: "Counter" })).toBeUndefined();
  });

  it("never flags anything on desktop", () => {
    isDesktop.mockReturnValue(true);
    isWebSerialSupported.mockReturnValue(false);
    expect(hostLimitation({ kind: "node", type: "Led" })).toBeUndefined();
    expect(hostLimitation({ kind: "node", type: "Midi" })).toBeUndefined();
  });

  it("leaves unaffected node types alone", () => {
    expect(hostLimitation({ kind: "node", type: "Counter" })).toBeUndefined();
    expect(hostLimitation({ kind: "node", type: undefined })).toBeUndefined();
    // Hotkey works in both hosts — the browser dispatches into the wasm runtime.
    expect(hostLimitation({ kind: "node", type: "Hotkey" })).toBeUndefined();
  });

  it("only flags Midi when the browser has no Web MIDI", () => {
    const nav = globalThis.navigator as unknown as { requestMIDIAccess?: unknown };
    const original = nav.requestMIDIAccess;

    nav.requestMIDIAccess = () => Promise.resolve({});
    expect(hostLimitation({ kind: "node", type: "Midi" })).toBeUndefined();

    delete nav.requestMIDIAccess;
    expect(hostLimitation({ kind: "node", type: "Midi" })?.reason).toContain("Web MIDI");

    if (original !== undefined) nav.requestMIDIAccess = original;
  });
});

describe("hostLimitation: broker", () => {
  const broker = (url: string) => hostLimitation({ kind: "broker", name: "Lab", url });

  it("accepts only MQTT-over-WebSocket URLs in a browser", () => {
    expect(broker("ws://localhost:9001")).toBeUndefined();
    expect(broker(" WSS://broker.example/mqtt ")).toBeUndefined();
    expect(broker("mqtt://broker.example:1883")?.reason).toBe(
      "Lab is not reachable from a browser — use a ws:// or wss:// broker, or the desktop app.",
    );
    expect(broker("broker.example")).toBeDefined();
  });

  it("accepts any scheme on desktop", () => {
    isDesktop.mockReturnValue(true);
    expect(broker("mqtt://broker.example:1883")).toBeUndefined();
    expect(broker("ws://localhost:9001")).toBeUndefined();
  });

  it("says nothing about a blank URL — unconfigured, not unreachable", () => {
    expect(broker("")).toBeUndefined();
    expect(broker("   ")).toBeUndefined();
  });
});

describe("hostLimitation: provider", () => {
  const cli = { kind: "cli", baseUrl: "claude" };
  const http = { kind: "http", baseUrl: "https://api.openai.com/v1" };
  const on = (provider: { kind?: string }, surface: "config" | "node" | "ask-ai") =>
    hostLimitation({ kind: "provider", provider, surface });

  it("rules a CLI out of every surface in a browser", () => {
    // That outranks any surface-specific objection — one badge, not two.
    for (const surface of ["config", "node", "ask-ai"] as const) {
      expect(on(cli, surface)?.label).toBe("studio only");
    }
  });

  it("on desktop only Ask AI objects: these CLIs cannot call flow tools", () => {
    isDesktop.mockReturnValue(true);
    expect(on(cli, "config")).toBeUndefined();
    expect(on(cli, "node")).toBeUndefined();
    const limitation = on(cli, "ask-ai");
    expect(limitation?.label).toBe("no flow tools");
    expect(limitation?.reason).toContain("cannot call Microflow's");
  });

  it("never limits an HTTP provider — its failures are reachability", () => {
    expect(on(http, "ask-ai")).toBeUndefined();
    expect(hostLimitation({ kind: "provider", provider: undefined, surface: "ask-ai" })).toBeUndefined();
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
