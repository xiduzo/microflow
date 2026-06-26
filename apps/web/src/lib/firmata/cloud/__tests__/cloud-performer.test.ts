// Browser CloudPerformer seam (ADR-0009). Proves the cloud half is unit-testable
// in isolation now that it no longer lives inside the FlowReactor: a stub
// `MqttClientFactory` stands in for a real broker, `fetch` is stubbed for the LLM
// transport, and the two runtime re-entry points (LLM result / inbound message)
// are captured as plain callbacks. The behavioural twin of the desktop
// `CloudPerformer` tests in `src-tauri/src/runtime/host.rs` (latest-wins LLM
// cancellation + the relocated MQTT/LLM IO), here against the browser primitives.

import { afterEach, describe, expect, test } from "bun:test";
import {
  CloudPerformer,
  type CloudDeps,
  type FigmaAnnounce,
  type FigmaPublish,
} from "../cloud-performer";
import type { BrokerConn, MqttClientFactory, MqttClientLike } from "../mqtt-client";
import type { ActiveSub } from "../mqtt-subscriptions";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: typeof fetch): void {
  globalThis.fetch = impl;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(5);
}

/** A fake mqtt client that records every call the performer makes — the stub that
 *  stands in for a real broker connection through the `MqttClientFactory` seam. */
class FakeMqttClient implements MqttClientLike {
  readonly subscriptions: string[] = [];
  readonly publishes: Array<{ topic: string; message: string; retain: boolean }> = [];
  ended = false;
  // The performer registers message/error handlers but the test never fires them.
  on(..._args: unknown[]): void {}
  subscribe(topic: string, callback?: (error?: Error | null) => void): void {
    this.subscriptions.push(topic);
    callback?.(null);
  }
  unsubscribe(topic: string): void {
    const index = this.subscriptions.indexOf(topic);
    if (index >= 0) this.subscriptions.splice(index, 1);
  }
  publish(topic: string, message: string, opts: { retain: boolean }): void {
    this.publishes.push({ topic, message, retain: opts.retain });
  }
  end(): void {
    this.ended = true;
  }
}

/** One fake client per broker id, exposed so assertions can read what was sent. */
class StubMqttClientFactory implements MqttClientFactory {
  readonly clients = new Map<string, FakeMqttClient>();
  create(conn: BrokerConn): MqttClientLike {
    const client = new FakeMqttClient();
    this.clients.set(conn.id, client);
    return client;
  }
}

type Inject = { source: string; handle: string; value: unknown };

/** A faithful TS twin of core's `figma_announce_actions`, injected so the Figma
 *  seam runs without the wasm runtime. The real policy is unit-tested in Rust
 *  (`subscriptions.rs`); here the stub just lets the performer's publish plumbing
 *  be asserted. */
const figmaAnnounceStub: FigmaAnnounce = (prev, next) => {
  const actions: FigmaPublish[] = [];
  for (const [uid, brokerId] of Object.entries(prev)) {
    if (!(uid in next)) {
      actions.push({ brokerId, topic: `microflow/${uid}/app/status`, payload: "disconnected", retain: true });
    }
  }
  for (const [uid, brokerId] of Object.entries(next)) {
    if (uid in prev) continue;
    actions.push({ brokerId, topic: `microflow/${uid}/app/status`, payload: "connected", retain: true });
    actions.push({ brokerId, topic: `microflow/${uid}/app/variables/request`, payload: "", retain: false });
  }
  return actions;
};

/** Build a performer over fakes; returns the captured re-entry log + the stub
 *  factory so tests can assert what crossed each seam. */
function setup(overrides: Partial<CloudDeps> = {}) {
  const injects: Inject[] = [];
  const factory = new StubMqttClientFactory();
  const cloud: CloudDeps = {
    resolveLlmProvider: () => ({ baseUrl: "http://llm.test", apiKey: "" }),
    resolveBroker: (id) => ({ id, url: "wss://broker.test" }),
    ...overrides,
  };
  const performer = new CloudPerformer(
    cloud,
    (source, handle, value) => injects.push({ source, handle, value }),
    () => {},
    figmaAnnounceStub,
    factory,
  );
  return { performer, factory, injects };
}

const llmRequest = (source: string, prompt: string): ActiveLlmReq => ({
  source,
  kind: "llmGenerate",
  providerId: "p",
  model: "m",
  system: null,
  prompt,
});
type ActiveLlmReq = Extract<Parameters<CloudPerformer["perform"]>[0], { kind: "llmGenerate" }>;

describe("CloudPerformer (ADR-0009 cloud seam)", () => {
  test("(a) llmGenerate re-enters value/done via the resultInjector", async () => {
    stubFetch(async () => jsonResponse({ choices: [{ message: { content: "hi back" } }] }));
    const { performer, injects } = setup();

    performer.perform(llmRequest("llm", "hello"));
    await waitFor(() => injects.some((i) => i.handle === "done"));

    // thinking=false, then value, then done — the same handles the desktop injects.
    expect(injects).toEqual([
      { source: "llm", handle: "thinking", value: false },
      { source: "llm", handle: "value", value: "hi back" },
      { source: "llm", handle: "done", value: true },
    ]);
  });

  test("(b) a second llmGenerate for the same source aborts the first (latest-wins)", async () => {
    let firstSignal: AbortSignal | undefined;
    let resolveSecond: ((text: string) => void) | undefined;
    let call = 0;
    stubFetch((_input, init) => {
      call += 1;
      const signal = init?.signal ?? undefined;
      if (call === 1) {
        firstSignal = signal;
        // Hang until aborted, then reject like a real aborted fetch.
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return new Promise<Response>((resolve) => {
        resolveSecond = (text) => resolve(jsonResponse({ choices: [{ message: { content: text } }] }));
      });
    });

    const { performer, injects } = setup();

    performer.perform(llmRequest("llm", "first"));
    await waitFor(() => firstSignal !== undefined);
    performer.perform(llmRequest("llm", "second")); // supersedes — must abort the first

    expect(firstSignal?.aborted).toBe(true);

    resolveSecond?.("second-answer");
    await waitFor(() => injects.some((i) => i.handle === "done"));

    // Only the second generation's result re-enters; the aborted first drops silently.
    expect(injects).toEqual([
      { source: "llm", handle: "thinking", value: false },
      { source: "llm", handle: "value", value: "second-answer" },
      { source: "llm", handle: "done", value: true },
    ]);
  });

  test("(c) reconcile subscribes the desired topics and publishes the Figma connect", () => {
    const { performer, factory } = setup();
    const reconciled: ActiveSub[] = [
      { brokerId: "b1", topic: "microflow/uid-1/figma/variable/1-2", nodeId: "fig", kind: "topicAware" },
    ];

    performer.reconcile(reconciled);

    const client = factory.clients.get("b1");
    expect(client).toBeDefined();
    expect(client?.subscriptions).toContain("microflow/uid-1/figma/variable/1-2");
    // The Figma handshake for a newly-appeared uid: retained `connected` status +
    // a (non-retained) variables request (mirrors the desktop flow_update tail).
    expect(client?.publishes).toContainEqual({
      topic: "microflow/uid-1/app/status",
      message: "connected",
      retain: true,
    });
    expect(client?.publishes).toContainEqual({
      topic: "microflow/uid-1/app/variables/request",
      message: "",
      retain: false,
    });
  });
});
