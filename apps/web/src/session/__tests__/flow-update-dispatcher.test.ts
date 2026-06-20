import { describe, expect, test } from "bun:test";
import { FlowDocument, type FlowNode } from "@microflow/collab";
import {
  FlowUpdateDispatcher,
  ManualDispatchScheduler,
  applyHostAdapterPatches,
  buildFlowUpdate,
  gatherBrokers,
  gatherProviders,
  runtimeRelevantKey,
  type HostSnapshot,
  type NodeAdapterRegistry,
} from "../flow-update-dispatcher";
import type { FlowUpdate } from "../flow-update-sender";
import { RecordingFlowUpdateSender } from "../flow-update-sender";
import type { FlowSession } from "../flow-session";

const EMPTY_REGISTRY: NodeAdapterRegistry = {};

const mkNode = (id: string, overrides: Partial<FlowNode> = {}): FlowNode => ({
  id,
  type: "Led",
  position: { x: 0, y: 0 },
  data: {},
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
  };
}

// =========================================================================
// Pure helpers
// =========================================================================

describe("gatherBrokers", () => {
  test("filters allBrokers by referenced IDs", () => {
    const all = [
      { id: "a", name: "A", url: "mqtt://a", isDefault: false },
      { id: "b", name: "B", url: "mqtt://b", isDefault: false },
      { id: "c", name: "C", url: "mqtt://c", username: "u", password: "p", isDefault: false },
    ];
    const result = gatherBrokers(new Set(["a", "c"]), all);
    expect(result.map((b) => b.id)).toEqual(["a", "c"]);
    expect(result[1]).toEqual({
      id: "c",
      name: "C",
      url: "mqtt://c",
      username: "u",
      password: "p",
    });
  });

  test("empty ID set yields empty array", () => {
    expect(gatherBrokers(new Set(), [{ id: "a", name: "A", url: "x", isDefault: false }])).toEqual(
      [],
    );
  });
});

describe("gatherProviders", () => {
  test("projects to snake_case wire shape", () => {
    const result = gatherProviders([
      { id: "p1", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "sk-x", isDefault: true },
    ]);
    expect(result).toEqual([
      { id: "p1", name: "OpenAI", base_url: "https://api.openai.com", api_key: "sk-x" },
    ]);
  });
});

describe("buildFlowUpdate", () => {
  test("composes nodes + edges + brokers + providers from doc and host snapshot", () => {
    const doc = FlowDocument.createEmpty();
    doc.addNode(mkNode("n1"));
    doc.addEdge({ id: "e1", source: "n1", target: "n2" });

    const snapshot: HostSnapshot = {
      brokers: [],
      providers: [
        {
          id: "p1",
          name: "Local",
          baseUrl: "http://localhost:8080",
          apiKey: "",
          isDefault: true,
        },
      ],
      figma: { uniqueId: null },
    };

    const update = buildFlowUpdate(doc, snapshot, EMPTY_REGISTRY);
    expect(update.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(update.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(update.brokers).toEqual([]);
    expect(update.providers).toEqual([
      { id: "p1", name: "Local", base_url: "http://localhost:8080", api_key: "" },
    ]);
  });

  test("nodes without an instance pass through unchanged", () => {
    const doc = FlowDocument.createEmpty();
    doc.addNode(mkNode("plain", { data: { value: 42 } }));
    const update = buildFlowUpdate(doc, emptySnapshot(), EMPTY_REGISTRY);
    expect(update.nodes[0]!.data).toEqual({ value: 42 });
  });
});

describe("runtimeRelevantKey", () => {
  const base = (): FlowUpdate => ({
    nodes: [mkNode("n1", { data: { value: 1 } })],
    edges: [{ id: "e1", source: "n1", target: "n2", sourceHandle: "value", targetHandle: "in" }],
    brokers: [],
    providers: [],
  });

  test("ignores node position (visual-only field)", () => {
    const a = base();
    const b = base();
    b.nodes[0]!.position = { x: 999, y: -42 };
    expect(runtimeRelevantKey(a)).toBe(runtimeRelevantKey(b));
  });

  test("reflects node data changes", () => {
    const a = base();
    const b = base();
    b.nodes[0]!.data = { value: 2 };
    expect(runtimeRelevantKey(a)).not.toBe(runtimeRelevantKey(b));
  });

  test("reflects edge changes", () => {
    const a = base();
    const b = base();
    b.edges = [
      ...b.edges,
      { id: "e2", source: "n2", target: "n3", sourceHandle: "value", targetHandle: "in" },
    ];
    expect(runtimeRelevantKey(a)).not.toBe(runtimeRelevantKey(b));
  });

  test("stable under node reordering", () => {
    const a = { ...base(), nodes: [mkNode("n1"), mkNode("n2")], edges: [] };
    const b = { ...base(), nodes: [mkNode("n2"), mkNode("n1")], edges: [] };
    expect(runtimeRelevantKey(a)).toBe(runtimeRelevantKey(b));
  });
});

describe("applyHostAdapterPatches", () => {
  test("adapter.prepareData merges into node data", () => {
    const registry: NodeAdapterRegistry = {
      Figma: {
        adapter: {
          prepareData: (_node, hosts) =>
            hosts.figma.uniqueId ? { uniqueId: hosts.figma.uniqueId } : undefined,
        },
      },
    };
    const nodes = [mkNode("n1", { data: { instance: "Figma" } })];
    const { nodes: patched } = applyHostAdapterPatches(
      nodes,
      { figma: { uniqueId: "u-123" } },
      registry,
    );
    expect(patched[0]!.data.uniqueId).toBe("u-123");
  });

  test("adapter.brokerIds is collected across nodes", () => {
    const registry: NodeAdapterRegistry = {
      Mqtt: {
        adapter: {
          brokerIds: (node) => (node.data.brokerId ? [String(node.data.brokerId)] : []),
        },
      },
    };
    const nodes = [
      mkNode("a", { data: { instance: "Mqtt", brokerId: "broker-1" } }),
      mkNode("b", { data: { instance: "Mqtt", brokerId: "broker-2" } }),
      mkNode("c", { data: { instance: "Mqtt", brokerId: "broker-1" } }),
    ];
    const { brokerIds } = applyHostAdapterPatches(
      nodes,
      { figma: { uniqueId: null } },
      registry,
    );
    expect([...brokerIds].sort()).toEqual(["broker-1", "broker-2"]);
  });

  test("unknown instance falls through unchanged, no broker collection", () => {
    const { nodes, brokerIds } = applyHostAdapterPatches(
      [mkNode("n1", { data: { instance: "Unknown" } })],
      { figma: { uniqueId: null } },
      {},
    );
    expect(nodes[0]!.data).toEqual({ instance: "Unknown" });
    expect(brokerIds.size).toBe(0);
  });
});

// =========================================================================
// Dispatcher integration
// =========================================================================

describe("FlowUpdateDispatcher", () => {
  test("fires immediate dispatch on construction (initial sync)", async () => {
    const doc = FlowDocument.createEmpty();
    const sender = new RecordingFlowUpdateSender();
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      makeSession(doc),
      emptySnapshot,
      sender,
      scheduler,
      EMPTY_REGISTRY,
    );

    expect(scheduler.hasPending).toBe(true);
    scheduler.flush();
    await Promise.resolve();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.nodes).toEqual([]);

    dispatcher.destroy();
  });

  test("doc mutation schedules a dispatch", async () => {
    const doc = FlowDocument.createEmpty();
    const sender = new RecordingFlowUpdateSender();
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      makeSession(doc),
      emptySnapshot,
      sender,
      scheduler,
      EMPTY_REGISTRY,
    );

    scheduler.flush(); // initial
    await Promise.resolve();

    doc.addNode(mkNode("n1"));
    expect(scheduler.hasPending).toBe(true);
    scheduler.flush();
    await Promise.resolve();

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1]!.nodes.map((n) => n.id)).toEqual(["n1"]);

    dispatcher.destroy();
  });

  test("multiple mutations between flushes coalesce into one dispatch", async () => {
    const doc = FlowDocument.createEmpty();
    const sender = new RecordingFlowUpdateSender();
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      makeSession(doc),
      emptySnapshot,
      sender,
      scheduler,
      EMPTY_REGISTRY,
    );

    scheduler.flush(); // initial
    await Promise.resolve();
    sender.sent.length = 0;

    doc.addNode(mkNode("a"));
    doc.addNode(mkNode("b"));
    doc.addNode(mkNode("c"));
    scheduler.flush();
    await Promise.resolve();

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);

    dispatcher.destroy();
  });

  test("snapshot provider re-read on every dispatch (credential rotation)", async () => {
    const doc = FlowDocument.createEmpty();
    const sender = new RecordingFlowUpdateSender();
    const scheduler = new ManualDispatchScheduler();
    let key = "sk-old";
    const provider = (): HostSnapshot => ({
      brokers: [],
      providers: [
        { id: "p", name: "L", baseUrl: "http://x", apiKey: key, isDefault: false },
      ],
      figma: { uniqueId: null },
    });

    const dispatcher = new FlowUpdateDispatcher(makeSession(doc), provider, sender, scheduler, EMPTY_REGISTRY);
    scheduler.flush();
    await Promise.resolve();
    expect(sender.sent[0]!.providers[0]!.api_key).toBe("sk-old");

    key = "sk-new";
    doc.addNode(mkNode("n1"));
    scheduler.flush();
    await Promise.resolve();
    expect(sender.sent[1]!.providers[0]!.api_key).toBe("sk-new");

    dispatcher.destroy();
  });

  test("scripted sender error is surfaced but does not crash", async () => {
    const doc = FlowDocument.createEmpty();
    const sender = new RecordingFlowUpdateSender();
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      makeSession(doc),
      emptySnapshot,
      sender,
      scheduler,
      EMPTY_REGISTRY,
    );

    // Drain the initial dispatch fired by construction.
    scheduler.flush();
    await Promise.resolve();

    sender.scriptError("backend down");
    const result = await dispatcher.dispatchNow();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("backend down");

    dispatcher.destroy();
  });

  test("destroy unobserves doc and cancels pending dispatch", async () => {
    const doc = FlowDocument.createEmpty();
    const sender = new RecordingFlowUpdateSender();
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      makeSession(doc),
      emptySnapshot,
      sender,
      scheduler,
      EMPTY_REGISTRY,
    );

    scheduler.flush(); // initial
    await Promise.resolve();
    sender.sent.length = 0;

    dispatcher.destroy();
    doc.addNode(mkNode("after-destroy"));

    expect(scheduler.hasPending).toBe(false);
    expect(sender.sent).toHaveLength(0);
  });

  test("destroy is idempotent", () => {
    const doc = FlowDocument.createEmpty();
    const sender = new RecordingFlowUpdateSender();
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      makeSession(doc),
      emptySnapshot,
      sender,
      scheduler,
      EMPTY_REGISTRY,
    );
    dispatcher.destroy();
    expect(() => dispatcher.destroy()).not.toThrow();
  });

  test("dispatchNow after destroy returns error result", async () => {
    const doc = FlowDocument.createEmpty();
    const sender = new RecordingFlowUpdateSender();
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      makeSession(doc),
      emptySnapshot,
      sender,
      scheduler,
      EMPTY_REGISTRY,
    );
    dispatcher.destroy();
    const result = await dispatcher.dispatchNow();
    expect(result.ok).toBe(false);
  });

  test("remote-origin updates also schedule dispatch (collab parity)", async () => {
    const doc = FlowDocument.createEmpty();
    const sender = new RecordingFlowUpdateSender();
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      makeSession(doc),
      emptySnapshot,
      sender,
      scheduler,
      EMPTY_REGISTRY,
    );

    scheduler.flush();
    await Promise.resolve();
    sender.sent.length = 0;

    // Simulate a remote update on the same doc
    doc.doc.transact(() => {
      doc.nodes.set("remote-n", mkNode("remote-n"));
    }, "remote");

    expect(scheduler.hasPending).toBe(true);
    scheduler.flush();
    await Promise.resolve();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.nodes.map((n) => n.id)).toEqual(["remote-n"]);

    dispatcher.destroy();
  });

  test("position-only change does not re-dispatch (no runtime delta)", async () => {
    const doc = FlowDocument.createEmpty();
    doc.addNode(mkNode("n1"));
    const sender = new RecordingFlowUpdateSender();
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      makeSession(doc),
      emptySnapshot,
      sender,
      scheduler,
      EMPTY_REGISTRY,
    );

    scheduler.flush(); // initial dispatch (n1)
    await Promise.resolve();
    sender.sent.length = 0;

    doc.updateNodePosition("n1", { x: 123, y: 456 });
    expect(scheduler.hasPending).toBe(true);
    scheduler.flush();
    await Promise.resolve();
    expect(sender.sent).toHaveLength(0);

    // A real data change still dispatches.
    doc.updateNodeData("n1", { value: 7 });
    scheduler.flush();
    await Promise.resolve();
    expect(sender.sent).toHaveLength(1);

    dispatcher.destroy();
  });

  test("dispatchNow forces a send even with no runtime delta", async () => {
    const doc = FlowDocument.createEmpty();
    doc.addNode(mkNode("n1"));
    const sender = new RecordingFlowUpdateSender();
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      makeSession(doc),
      emptySnapshot,
      sender,
      scheduler,
      EMPTY_REGISTRY,
    );

    scheduler.flush(); // initial
    await Promise.resolve();
    sender.sent.length = 0;

    await dispatcher.dispatchNow();
    expect(sender.sent).toHaveLength(1);

    dispatcher.destroy();
  });
});
