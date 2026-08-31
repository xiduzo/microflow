// CloudPerformer seam (ADR-0009). Proves the cloud half is unit-testable in
// isolation now that it no longer lives inside the FlowReactor: a stub
// `MqttClientFactory` stands in for a real broker, `fetch` is stubbed for the LLM
// transport, and the two runtime re-entry points (LLM result / inbound message)
// are captured as plain callbacks.
//
// Since ADR-0021 the LLM cases here are not a "browser twin" of anything — this
// performer is the only LLM performer, the desktop drives the same transport
// through `use-llm-requests.ts`. So these are THE tests for latest-wins
// cancellation and for what re-enters the runtime after a generation.

import { afterEach, describe, expect, test } from "bun:test";
import {
  CloudPerformer,
  type CloudDeps,
  type FigmaAnnounce,
  type FigmaPublish,
} from "./cloud-performer";
import type { BrokerConn, MqttClientFactory, MqttClientLike } from "./mqtt-client";
import type { ActiveSub } from "./mqtt-subscriptions";
import { resetHostFetch } from "@/lib/ai/endpoint";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetHostFetch();
});

function stubFetch(impl: typeof fetch): void {
  globalThis.fetch = impl;
  // `hostFetch` memoises what it resolved, so a stub would leak between tests.
  resetHostFetch();
}

/** An OpenAI chat-completions SSE stream carrying `deltas`, then `[DONE]`. */
function streamResponse(deltas: string[]): Response {
  const frames = deltas.map((delta, index) =>
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [
        {
          index: 0,
          delta: { content: delta },
          finish_reason: index === deltas.length - 1 ? "stop" : null,
        },
      ],
    }),
  );
  return new Response(`${frames.map((f) => `data: ${f}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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
  test("(a) llmGenerate streams into value, then re-enters thinking/value/done", async () => {
    stubFetch((async () => streamResponse(["hi", " back"])) as typeof fetch);
    const { performer, injects } = setup();

    performer.perform(llmRequest("llm", "hello"));
    await waitFor(() => injects.some((i) => i.handle === "done"));

    // Each delta re-injects the whole answer so far on `value` (every inject
    // overwrites the last, so a Monitor fills in as the model writes), and only
    // then does the terminal trio land — the same handles both hosts inject on.
    expect(injects).toEqual([
      { source: "llm", handle: "value", value: "hi" },
      { source: "llm", handle: "value", value: "hi back" },
      { source: "llm", handle: "thinking", value: false },
      { source: "llm", handle: "value", value: "hi back" },
      { source: "llm", handle: "done", value: true },
    ]);
  });

  test("(b) a second llmGenerate for the same source supersedes the first (latest-wins)", async () => {
    let firstAborted = false;
    let releaseSecond: (() => void) | undefined;
    let call = 0;
    stubFetch(((_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const signal = init?.signal ?? undefined;
      if (call === 1) {
        // Hang until aborted, then reject the way a real aborted fetch does.
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            firstAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return new Promise<Response>((resolve) => {
        releaseSecond = () => resolve(streamResponse(["second-answer"]));
      });
    }) as unknown as typeof fetch);

    const { performer, injects } = setup();

    performer.perform(llmRequest("llm", "first"));
    await waitFor(() => call === 1);
    performer.perform(llmRequest("llm", "second")); // supersedes — must abort the first

    await waitFor(() => firstAborted);
    expect(firstAborted).toBe(true);

    await waitFor(() => releaseSecond !== undefined);
    releaseSecond?.();
    await waitFor(() => injects.some((i) => i.handle === "done"));

    // Only the second generation re-enters; the aborted first drops silently —
    // no `error` inject, because a superseded result would route nowhere.
    expect(injects.filter((i) => i.handle === "error")).toEqual([]);
    expect(injects.at(-2)).toEqual({
      source: "llm",
      handle: "value",
      value: "second-answer",
    });
    expect(injects.at(-1)).toEqual({ source: "llm", handle: "done", value: true });
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
