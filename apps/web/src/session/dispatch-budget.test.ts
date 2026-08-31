/**
 * Dispatch-budget tests: how much work a canvas edit costs on its way into the
 * runtime, counted rather than timed.
 *
 * `FlowUpdateDispatcher` is the canvas's only channel into the flow engine —
 * every edit funnels through it and comes out as one `FlowUpdate` crossing into
 * Rust (Tauri IPC on the desktop, a wasm call in the browser). Two budgets
 * matter, and both are exact integers:
 *
 * 1. **Crossings.** How many times an edit actually reaches the runtime. A node
 *    the user merely dragged must not, or every drag tears down and rebuilds the
 *    flow's MQTT and Figma subscriptions.
 * 2. **Serialisations.** How much work is spent deciding whether to cross.
 *    `runtimeRelevantKey` sorts and `JSON.stringify`s the entire flow, so on a
 *    large canvas the deciding costs real time — and it used to run twice per
 *    dispatch, once to compare and once to remember.
 *
 * Counting `JSON.stringify` calls is a crude instrument, but it is a *stable*
 * one: it does not care how fast the machine is, and it fails loudly if someone
 * reintroduces a second full serialisation of the flow.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FlowDocument, type FlowNode } from "@microflow/collab";
import {
  FlowUpdateDispatcher,
  ManualDispatchScheduler,
  type HostSnapshot,
  type NodeAdapterRegistry,
} from "./flow-update-dispatcher";
import { RecordingFlowUpdateSender } from "./flow-update-sender";
import type { FlowSession } from "./flow-session";

const EMPTY_REGISTRY: NodeAdapterRegistry = {};

const mkNode = (id: string, overrides: Partial<FlowNode> = {}): FlowNode => ({
  id,
  type: "Led",
  position: { x: 0, y: 0 },
  data: { instance: "Led", pin: 13 },
  ...overrides,
});

const emptySnapshot = (): HostSnapshot => ({
  brokers: [],
  providers: [],
  figma: { uniqueId: null },
});

function makeSession(doc: FlowDocument): FlowSession {
  return {
    flowId: "test",
    mode: "local",
    readOnly: false,
    doc,
    sync: { kind: "local", destroy: () => {} },
    destroy: () => {},
  } as FlowSession;
}

// ---------------------------------------------------------------------------
// JSON.stringify counter
// ---------------------------------------------------------------------------

const realStringify = JSON.stringify;
let stringifyCalls = 0;

beforeEach(() => {
  stringifyCalls = 0;
  JSON.stringify = ((...args: Parameters<typeof realStringify>) => {
    stringifyCalls += 1;
    return realStringify(...args);
  }) as typeof JSON.stringify;
});

afterEach(() => {
  JSON.stringify = realStringify;
});

/** A dispatcher wired to a manual scheduler, so a "frame" is `flush()`. */
async function setup(nodeCount = 25) {
  const doc = FlowDocument.createEmpty();
  for (let i = 0; i < nodeCount; i++) doc.addNode(mkNode(`n${i}`));

  const sender = new RecordingFlowUpdateSender();
  const scheduler = new ManualDispatchScheduler();
  const dispatcher = new FlowUpdateDispatcher(
    makeSession(doc),
    emptySnapshot,
    sender,
    scheduler,
    EMPTY_REGISTRY,
  );
  // Construction requests the initial dispatch; run it — and let it settle, so
  // the dispatcher has recorded its key — and the tests below start from a
  // runtime that already holds the current flow.
  scheduler.flush();
  await Promise.resolve();
  return { doc, sender, scheduler, dispatcher };
}

describe("dispatch budget — crossings into the runtime", () => {
  test("moving a node does not reach the runtime at all", async () => {
    const { doc, sender, scheduler } = await setup();
    const before = sender.sent.length;

    for (let i = 0; i < 20; i++) {
      doc.updateNode("n3", { position: { x: i, y: i } });
      scheduler.flush();
      // The dispatcher records the key it sent only once `send` resolves, so a
      // skip needs the previous dispatch to have settled. Production gets that
      // for free — the real scheduler is debounced, so dispatches are never
      // back-to-back within a microtask the way a manual `flush()` makes them.
      await Promise.resolve();
    }

    // Position is not runtime-relevant. If this ever becomes non-zero, every
    // drag re-subscribes the flow's brokers.
    expect(sender.sent.length - before).toBe(0);
  });

  test("a real data change reaches the runtime exactly once", async () => {
    const { doc, sender, scheduler } = await setup();
    const before = sender.sent.length;

    doc.updateNodeData("n3", { instance: "Led", pin: 9 });
    scheduler.flush();
    await Promise.resolve();

    expect(sender.sent.length - before).toBe(1);
  });

  test("re-applying the same data is a no-op crossing", async () => {
    const { doc, sender, scheduler } = await setup();
    doc.updateNodeData("n3", { instance: "Led", pin: 9 });
    scheduler.flush();
    await Promise.resolve();
    const after = sender.sent.length;

    doc.updateNodeData("n3", { instance: "Led", pin: 9 });
    scheduler.flush();
    await Promise.resolve();

    expect(sender.sent.length - after).toBe(0);
  });
});

describe("dispatch budget — serialisations per dispatch", () => {
  test("a dispatch that crosses serialises the flow once, not twice", async () => {
    const { doc, scheduler } = await setup();

    doc.updateNodeData("n3", { instance: "Led", pin: 9 });
    stringifyCalls = 0;
    scheduler.flush();
    await Promise.resolve();

    // One `runtimeRelevantKey`: computed to compare, then handed to `send` to
    // remember. Before this branch `send` derived it a second time, so a
    // dispatch cost two full sorts + stringifies of the whole flow.
    expect(stringifyCalls).toBe(1);
  });

  test("a skipped dispatch serialises once and stops", async () => {
    const { doc, scheduler } = await setup();
    doc.updateNodeData("n3", { instance: "Led", pin: 9 });
    scheduler.flush();
    await Promise.resolve();

    // No runtime-relevant change this time: the key is computed, compared,
    // and the dispatch is dropped before any further work.
    doc.updateNode("n3", { position: { x: 99, y: 99 } });
    stringifyCalls = 0;
    scheduler.flush();
    await Promise.resolve();

    expect(stringifyCalls).toBe(1);
  });
});
