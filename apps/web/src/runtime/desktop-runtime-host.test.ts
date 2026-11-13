// The desktop Runtime Host outlives the flow route. These drive it the way the
// app does — start once, attach the route's document, detach it on navigation —
// over a fake Tauri event bus, with no React, Tauri or store in scope.

import { describe, expect, test } from "bun:test";
import type { ComponentEvent } from "@/lib/bindings/ComponentEvent";
import type { RuntimeCrash } from "@/lib/bindings/RuntimeCrash";
import type { LlmGenerate } from "@/ai/llm-performer";
import type { EdgeLike } from "@/runtime/ingest/edge-index";
import {
  DesktopRuntimeHost,
  type DesktopRuntimeHostDeps,
  type HostAudio,
  type HostDocument,
} from "./desktop-runtime-host";

/** A Tauri event bus: `emit` reaches whoever is listening right now. */
class FakeBus {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  listen = <T>(event: string, handler: (payload: T) => void): Promise<() => void> => {
    const set = this.handlers.get(event) ?? new Set();
    this.handlers.set(event, set);
    const h = handler as (payload: unknown) => void;
    set.add(h);
    return Promise.resolve(() => set.delete(h));
  };

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  listeners(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

/** A generation the test settles by hand — "the reply arrives later". */
function deferredGenerate() {
  let finish: (text: string) => void = () => {};
  let delta: (text: string) => void = () => {};
  const generate: LlmGenerate = (_provider, _input, _signal, onDelta) => {
    delta = onDelta;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  };
  return { generate, finish: (text: string) => finish(text), delta: (text: string) => delta(text) };
}

function doc(edges: EdgeLike[], nodeIds: string[] = []): HostDocument {
  const fake = {
    getEdges: () => edges,
    onEdgesChange: () => () => {},
    getNode: () => undefined,
    getNodes: () => nodeIds.map((id) => ({ id })),
    onNodesChange: () => () => {},
  };
  return fake as unknown as HostDocument;
}

function rig() {
  const bus = new FakeBus();
  const invoked: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const ingested: Array<{ event: ComponentEvent; edges: ReadonlyArray<EdgeLike> }> = [];
  const crashes: Array<{ crash: RuntimeCrash; restart: () => Promise<void> }> = [];
  const retained: string[][] = [];
  let cleared = 0;
  const llm = deferredGenerate();
  const audio: HostAudio = {
    play: () => {},
    stop: () => {},
    retain: (ids) => retained.push(["a", "b", "c"].filter((id) => ids.has(id))),
    dispose: () => {},
  };
  const deps: DesktopRuntimeHostDeps = {
    listen: bus.listen,
    invoke: async (command, args) => {
      invoked.push({ command, args });
    },
    ingest: (event, edges) => ingested.push({ event, edges }),
    applyDiagnostic: () => {},
    clearDiagnostics: () => {
      cleared++;
    },
    resolveLlmProvider: () => ({ baseUrl: "http://llm.test", apiKey: "" }),
    generateLlm: llm.generate,
    createAudio: () => audio,
    dispatchPort: () => {},
    onCrash: (crash, restart) => crashes.push({ crash, restart }),
  };
  const host = new DesktopRuntimeHost(deps);
  return { bus, host, invoked, ingested, crashes, retained, cleared: () => cleared, llm };
}

const event = (source: string): ComponentEvent =>
  ({ source, sourceHandle: "value", value: 1, sequence: 1 }) as unknown as ComponentEvent;

const llmRequest = {
  source: "llm",
  kind: "llmGenerate",
  providerId: "p",
  model: "m",
  system: null,
  prompt: "hi",
} as const;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DesktopRuntimeHost", () => {
  test("keeps applying runtime events after the flow route unmounts", () => {
    const { bus, host, ingested } = rig();
    host.start();
    const edges: EdgeLike[] = [{ id: "e", source: "a", sourceHandle: "value", target: "b", targetHandle: "x" }];

    const detach = host.attach(doc(edges));
    bus.emit("component-events", [event("a")]);
    expect(ingested.at(-1)?.edges).toBe(edges);

    detach(); // navigate away: the route's effects clean up
    bus.emit("component-events", [event("a")]);
    expect(ingested).toHaveLength(2);
    expect(ingested.at(-1)?.edges).toEqual([]);
    expect(bus.listeners("component-events")).toBe(1);
  });

  test("an LLM reply that arrives after navigation is still delivered", async () => {
    const { bus, host, invoked, llm } = rig();
    host.start();
    const detach = host.attach(doc([]));

    bus.emit("llm-request", llmRequest);
    await tick();
    llm.delta("he");
    detach(); // the user leaves the flow while the model is still writing
    llm.finish("hello");
    await tick();

    expect(invoked.map((call) => [call.args?.handle, call.args?.value])).toEqual([
      ["value", "he"],
      ["thinking", false],
      ["value", "hello"],
      ["done", true],
    ]);
    expect(invoked.every((call) => call.command === "llm_result" && call.args?.source === "llm")).toBe(true);
  });

  test("a request emitted while no flow is open is still performed", async () => {
    const { bus, host, invoked, llm } = rig();
    host.start();
    host.attach(doc([]))(); // visited a flow, then left it

    bus.emit("llm-request", llmRequest);
    await tick();
    llm.finish("ok");
    await tick();
    expect(invoked.at(-1)?.args).toEqual({ source: "llm", handle: "done", value: true });
  });

  test("a later document replaces the earlier one; the earlier detach leaves it alone", () => {
    const { bus, host, ingested, retained } = rig();
    host.start();
    const first = doc([], ["a"]);
    const secondEdges: EdgeLike[] = [{ id: "e2", source: "c", sourceHandle: "value", target: "d", targetHandle: "x" }];
    const detachFirst = host.attach(first);
    host.attach(doc(secondEdges, ["c"]));
    detachFirst(); // the old route unmounts after the new one mounted

    bus.emit("component-event", event("c"));
    expect(ingested.at(-1)?.edges).toBe(secondEdges);
    // Music nodes not in the open flow stop.
    expect(retained.at(-1)).toEqual(["c"]);
  });

  test("start is idempotent: one listener per event however often it mounts", async () => {
    const { bus, host } = rig();
    host.start();
    host.start();
    expect(bus.listeners("llm-request")).toBe(1);
    host.stop();
    await tick(); // Tauri's unlisten resolves asynchronously
    expect(bus.listeners("llm-request")).toBe(0);
  });

  test("a runtime crash clears stale badges, surfaces, and can restart the runtime", async () => {
    const { bus, host, crashes, invoked, cleared } = rig();
    host.start();
    const crash: RuntimeCrash = {
      fingerprint: "0badf00d",
      op: "dispatch",
      location: "microflow-core/src/nodes/x.rs:1",
      recovered: false,
      crashes: 3,
    };

    bus.emit("runtime-crashed", crash);
    expect(cleared()).toBe(1);
    expect(crashes.map((c) => c.crash)).toEqual([crash]);

    await crashes[0]!.restart();
    expect(invoked.at(-1)?.command).toBe("runtime_restart");
  });
});
