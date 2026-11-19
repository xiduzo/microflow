// The design-tool handshake through the reactor: the announce policy is the
// compiled module's (`figmaAnnounceActions`), asked through the bridge, and
// what the plugins see on the broker when the flow engine dies.
//
// The runtime is a stand-in that traps when told to; the broker is a stub
// client that accepts every topic. Needs the generated module:
// `bun run build:wasm:runtime`.

import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CloudDeps, MqttClientFactory, Will } from "@/cloud/cloud-performer";
import type { DesiredSub } from "@/lib/bindings/DesiredSub";
import { FlowReactor } from "./flow-reactor";
import type { FlowRuntimeCalls } from "./runtime-bridge";
import { initSync } from "./generated/microflow_runtime_wasm.js";

initSync({
  module: readFileSync(new URL("./generated/microflow_runtime_wasm_bg.wasm", import.meta.url)),
});

const VARIABLE = "microflow/swift_fox/figma/variable/1-2";
const CONNECTED = "PUBLISH microflow/swift_fox/app/status connected retain";
const REQUEST = "PUBLISH microflow/swift_fox/app/variables/request ";
const DISCONNECTED = "PUBLISH microflow/swift_fox/app/status disconnected retain";
const STATUS = "microflow/swift_fox/app/status";
const TRAP = "unreachable executed";

/** A broker connection whose broker accepts every topic, and what reached it. */
class StubClient {
  connected = false;
  readonly wire: string[] = [];
  /** The will every link of this client carries. */
  constructor(readonly will: Will | undefined) {}
  private readonly connectListeners: Array<() => void> = [];
  on(event: string, handler: () => void): void {
    if (event === "connect") this.connectListeners.push(handler);
  }
  subscribe(topic: string, callback: (error?: Error | null) => void): void {
    this.wire.push(`SUBSCRIBE ${topic}`);
    callback(null);
  }
  unsubscribe(topic: string): void {
    this.wire.push(`UNSUBSCRIBE ${topic}`);
  }
  publish(topic: string, message: string, opts: { retain: boolean }): void {
    this.wire.push(`PUBLISH ${topic} ${message}${opts.retain ? " retain" : ""}`);
  }
  end(_force?: boolean, done?: () => void): void {
    if (this.connected) this.wire.push("DISCONNECT");
    this.connected = false;
    done?.();
  }
  connect(): void {
    this.connected = true;
    for (const listener of this.connectListeners) listener();
  }
}

/** A flow runtime whose flow subscribes one design variable on `b1`, and whose
 *  next `updateFlow` traps once `trap()` was called. */
function trappableRuntime() {
  let trapped = false;
  const desired: DesiredSub[] = [{ brokerId: "b1", topic: VARIABLE, nodeId: "fig", kind: "topicAware" }];
  const runtime = {
    setPins: () => undefined,
    updateFlow: () => {
      if (trapped) throw new WebAssembly.RuntimeError(TRAP);
      return JSON.stringify({
        outboundBytes: [],
        componentEvents: [],
        wakeups: [],
        cancellations: [],
        cloudRequests: [],
        nodeDiagnostics: [],
      });
    },
    reconcileSubscriptions: () => JSON.stringify(desired),
  } as unknown as FlowRuntimeCalls;
  return { runtime, trap: () => (trapped = true) };
}

function setup() {
  const clients: StubClient[] = [];
  const mqttClients: MqttClientFactory = {
    create: (_conn, will) => {
      const client = new StubClient(will);
      clients.push(client);
      return client;
    },
  };
  let url = "wss://one.test";
  const watchers = new Set<(brokerIds: readonly string[]) => void>();
  const cloud: CloudDeps = {
    resolveLlmProvider: () => undefined,
    resolveBroker: (id) => ({ id, url }),
    watchBrokers: (onChange) => {
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    },
  };
  const moveBroker = (to: string) => {
    url = to;
    for (const watcher of watchers) watcher(["b1"]);
  };
  return { clients, mqttClients, cloud, moveBroker };
}

describe("the design-tool handshake through the reactor", () => {
  test("an engine fault during an update: the update reports the fault, and the plugins are told Studio left", async () => {
    const { clients, mqttClients, cloud } = setup();
    const { runtime, trap } = trappableRuntime();
    const faults: string[] = [];
    // The board controller's answer to a fault: tear the reactor down, from
    // inside the call that trapped.
    let reactor: FlowReactor | undefined;
    reactor = await FlowReactor.attach(null, cloud, {
      runtime,
      mqttClients,
      onEngineFault: (message) => {
        faults.push(message);
        reactor?.dispose();
      },
    });
    const flow = { nodes: [], edges: [] };

    expect(reactor.applyFlow(flow)).toEqual({ ok: true });
    clients[0].connect();
    expect(clients[0].wire).toEqual([`SUBSCRIBE ${VARIABLE}`, CONNECTED, REQUEST]);
    // The compiled policy's goodbye is the will a new link carries.
    expect(clients[1].will).toEqual({ topic: STATUS, payload: "disconnected", retain: true });
    clients[1].connect();
    expect(clients[1].wire).toEqual([`SUBSCRIBE ${VARIABLE}`]);
    expect(clients[0].wire.slice(3)).toEqual(["DISCONNECT"]);

    trap();
    expect(reactor.applyFlow(flow)).toEqual({ ok: false, error: TRAP });

    expect(faults).toEqual([`The flow engine stopped: ${TRAP}`]);
    expect(clients[1].wire.slice(1)).toEqual([DISCONNECTED, "DISCONNECT"]);
  });

  test("a page that goes away tells the plugins Studio left; one back from the back/forward cache announces again", async () => {
    const { clients, mqttClients, cloud } = setup();
    const { runtime } = trappableRuntime();
    const reactor = await FlowReactor.attach(null, cloud, { runtime, mqttClients });
    reactor.applyFlow({ nodes: [], edges: [] });
    clients[0].connect();

    globalThis.dispatchEvent(new Event("pagehide"));
    expect(clients[0].wire.slice(3)).toEqual([DISCONNECTED]);
    globalThis.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(clients[0].wire.slice(4)).toEqual([CONNECTED, REQUEST]);

    reactor.dispose();
    expect(clients[0].wire.slice(6)).toEqual([DISCONNECTED, "DISCONNECT"]);
    // A reactor that is gone no longer watches the page.
    globalThis.dispatchEvent(new Event("pagehide"));
    expect(clients[0].wire).toHaveLength(8);
  });

  test("after an engine fault the module is asked nothing more, so nothing new is announced", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { clients, mqttClients, cloud, moveBroker } = setup();
      const { runtime, trap } = trappableRuntime();
      // A host that keeps the reactor after the fault.
      const reactor = await FlowReactor.attach(null, cloud, { runtime, mqttClients, onEngineFault: () => {} });
      const flow = { nodes: [], edges: [] };
      reactor.applyFlow(flow);
      clients[0].connect();
      trap();
      reactor.applyFlow(flow);

      // The broker's URL is corrected: the old connection is told Studio left,
      // the new one gets the subscription, and no `connected`. The link that
      // was being opened for the will is closed unconnected.
      moveBroker("wss://two.test");
      expect(clients).toHaveLength(3);
      clients[2].connect();

      expect(clients[0].wire.slice(3)).toEqual([DISCONNECTED, "DISCONNECT"]);
      expect(clients[1].wire).toEqual([]);
      expect(clients[2].will).toBeUndefined();
      expect(clients[2].wire).toEqual([`SUBSCRIBE ${VARIABLE}`]);

      reactor.dispose();
      expect(clients[2].wire).toEqual([`SUBSCRIBE ${VARIABLE}`, "DISCONNECT"]);
      expect(clients).toHaveLength(3);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
