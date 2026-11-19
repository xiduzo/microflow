import { describe, expect, test } from "bun:test";
import { FlowDocument, type FlowEdge, type FlowNode } from "@microflow/collab";

import { resolveNodeData } from "@/nodes/node-data-resolver";
import type { ComponentType } from "@/nodes/component-types.generated";
import { encodeFlowFile, MAX_FLOW_FILE_SIZE } from "./flow-file";
import { importFlowFile, type FlowFileSource } from "./import-flow";
import { openFlowFromContent } from "./open-flow";

function node(id: string, type: ComponentType): FlowNode {
  const resolved = resolveNodeData(type, {});
  if (!resolved.ok) throw new Error(resolved.error);
  return { id, type, position: { x: 0, y: 0 }, data: resolved.data };
}

const NODES = [node("a", "Interval"), node("b", "Led")];
const EDGES: FlowEdge[] = [{ id: "e", source: "a", sourceHandle: "event", target: "b", targetHandle: "toggle" }];

const fileOf = (text: string): FlowFileSource => ({ size: text.length, text: async () => text });
const flowFile = (name: string, nodes: unknown = NODES, edges: unknown = EDGES) =>
  fileOf(JSON.stringify({ meta: { name }, data: { nodes, edges }, version: 1 }));

/**
 * The app around an import, in memory: the real landing rule over a
 * `FlowDocument` as the local flow, and an account that records what it was
 * asked to create.
 */
function world(options: { signedIn: boolean; accountFails?: boolean; localStoreFails?: boolean }) {
  const local = FlowDocument.createEmpty();
  const created: Array<{ name: string; nodes: FlowNode[]; edges: FlowEdge[] }> = [];
  const shown: string[] = [];

  const ports = {
    open: (content: Parameters<typeof openFlowFromContent>[0], destination: Parameters<typeof openFlowFromContent>[1]) =>
      openFlowFromContent(content, destination, {
        signedIn: options.signedIn,
        async saveLocalFlow(nodes, edges) {
          if (options.localStoreFails) throw new Error("IndexedDB will not open");
          local.setFlowData(nodes, edges);
        },
        setActiveFlowId() {},
        navigate: (flowId) => shown.push(flowId),
      }),
    async createInAccount(flow: { name: string; nodes: FlowNode[]; edges: FlowEdge[] }) {
      created.push(flow);
      if (options.accountFails) throw new Error("You have reached the limit of 20 flows");
      return { id: "flow-1", name: flow.name };
    },
  };

  return { ports, created, shown, localFlow: () => local.getFlowData() };
}

describe("importFlowFile: a flow that is imported", () => {
  test("signed out: it replaces the local flow, is shown, and counts as imported", async () => {
    const { ports, created, shown, localFlow } = world({ signedIn: false });

    const report = await importFlowFile(flowFile("Blink"), ports);

    expect(report).toEqual({
      messages: [{ level: "success", title: "Flow imported", description: "2 nodes, 1 edges" }],
      imported: { where: "local", nodes: 2, edges: 1 },
    });
    expect(localFlow()).toEqual({ nodes: NODES, edges: EDGES });
    expect(shown).toEqual(["local"]);
    expect(created).toEqual([]);
  });

  test("signed in: it is created in the account under the file's name, and counts as imported", async () => {
    const { ports, created, shown, localFlow } = world({ signedIn: true });

    const report = await importFlowFile(flowFile("Blink"), ports);

    expect(created).toEqual([{ name: "Blink", nodes: NODES, edges: EDGES }]);
    expect(report).toEqual({
      messages: [{ level: "success", title: "Flow imported", description: "Blink has been created" }],
      imported: { where: "account", nodes: 2, edges: 1 },
    });
    expect(shown).toEqual(["flow-1"]);
    expect(localFlow()).toEqual({ nodes: [], edges: [] });
  });

  test("a file the app exported imports as it is", async () => {
    const { ports, created } = world({ signedIn: true });
    const text = encodeFlowFile({ name: "Exported" }, { nodes: NODES, edges: EDGES });

    const report = await importFlowFile(fileOf(text), ports);

    expect(created).toEqual([{ name: "Exported", nodes: NODES, edges: EDGES }]);
    expect(report.messages).toHaveLength(1);
  });

  test("a file without a name, or with a blank one, becomes \"Imported flow\"", async () => {
    for (const name of ["", "   "]) {
      const { ports, created } = world({ signedIn: true });
      const report = await importFlowFile(flowFile(name), ports);
      expect(created.map((flow) => flow.name)).toEqual(["Imported flow"]);
      expect(report.messages[0].description).toBe("Imported flow has been created");
    }

    const { ports, created } = world({ signedIn: true });
    await importFlowFile(fileOf(JSON.stringify({ data: { nodes: NODES, edges: EDGES } })), ports);
    expect(created.map((flow) => flow.name)).toEqual(["Imported flow"]);
  });

  test("a name longer than a flow's may be reaches the account shortened, and the user is told", async () => {
    const { ports, created } = world({ signedIn: true });

    const report = await importFlowFile(flowFile("n".repeat(250)), ports);

    expect(created[0].name).toBe("n".repeat(100));
    expect(report.imported).toBeDefined();
    expect(report.messages[1]).toEqual({
      level: "warning",
      title: "One thing to check in the imported flow",
      description: "The flow's name was longer than 100 characters and was shortened.",
    });
  });
});

describe("importFlowFile: what the user is told about the file", () => {
  test("every notice, when there are a few, the edges left out first", async () => {
    const { ports } = world({ signedIn: false });
    const { pin: _, ...withoutPin } = NODES[1].data;
    const nodes = [NODES[0], { ...NODES[1], data: withoutPin }];
    const edges = [...EDGES, { ...EDGES[0], id: "lost", target: "ghost" }];

    const report = await importFlowFile(flowFile("Blink", nodes, edges), ports);

    expect(report.imported).toEqual({ where: "local", nodes: 2, edges: 1 });
    expect(report.messages[1]).toEqual({
      level: "warning",
      title: "2 things to check in the imported flow",
      description:
        'The edge from "a" to "ghost" was left out: there is no node "ghost" in the file.\n' +
        'LED "b" had no "pin" in the file; the default is used.',
    });
  });

  test("the most important eight in full and the rest counted by kind, however many there are", async () => {
    const { ports } = world({ signedIn: false });
    // A thousand nodes without settings, and twelve edges to nodes that are not there.
    const nodes = Array.from({ length: 1_000 }, (_, index) => ({ id: `n${index}`, type: "Led", position: { x: 0, y: 0 } }));
    const edges = Array.from({ length: 12 }, (_, index) => ({ id: `e${index}`, source: "n0", sourceHandle: "value", target: `ghost-${index}`, targetHandle: "toggle" }));

    const report = await importFlowFile(flowFile("Big", nodes, edges), ports);

    const [, notices] = report.messages;
    expect(notices.title).toBe("1012 things to check in the imported flow");
    const lines = notices.description!.split("\n");
    expect(lines).toHaveLength(9);
    for (const line of lines.slice(0, 8)) expect(line).toContain("was left out: there is no node");
    expect(lines[8]).toBe("…and 1004 more: 4 edges left out, 1000 nodes given default settings.");
    expect(notices.description!.length).toBeLessThan(1_000);
  });
});

describe("importFlowFile: a flow that is not imported", () => {
  test("a file that is not a flow: the reason is shown, nothing is opened, nothing is counted", async () => {
    const { ports, created, shown, localFlow } = world({ signedIn: true });

    const report = await importFlowFile(fileOf("{ not json"), ports);

    expect(report).toEqual({
      messages: [
        {
          level: "error",
          title: "Failed to import flow",
          description: "This file is not a Microflow flow: it is not valid JSON.",
        },
      ],
    });
    expect(report.imported).toBeUndefined();
    expect(report.failure).toBeUndefined();
    expect(created).toEqual([]);
    expect(shown).toEqual([]);
    expect(localFlow()).toEqual({ nodes: [], edges: [] });
  });

  test("a file that is too large is turned away without being read", async () => {
    const { ports } = world({ signedIn: false });
    let read = false;
    const file: FlowFileSource = {
      size: MAX_FLOW_FILE_SIZE + 1,
      async text() {
        read = true;
        return "{}";
      },
    };

    const report = await importFlowFile(file, ports);

    expect(read).toBe(false);
    expect(report).toEqual({
      messages: [
        {
          level: "error",
          title: "Failed to import flow",
          description: "This file is not a Microflow flow: it is larger than 64 MB.",
        },
      ],
    });
  });

  test("a file that cannot be read: said, reported, not counted", async () => {
    const { ports, shown } = world({ signedIn: false });
    const unreadable = new Error("NotReadableError");

    const report = await importFlowFile({ size: 10, text: () => Promise.reject(unreadable) }, ports);

    expect(report).toEqual({
      messages: [{ level: "error", title: "Failed to import flow", description: "The file could not be read." }],
      failure: unreadable,
    });
    expect(shown).toEqual([]);
  });

  test("the account refuses it: the account's reason is shown, nothing is counted or reported", async () => {
    const { ports, shown, localFlow } = world({ signedIn: true, accountFails: true });

    const report = await importFlowFile(flowFile("Blink"), ports);

    expect(report).toEqual({
      messages: [
        { level: "error", title: "Failed to import flow", description: "You have reached the limit of 20 flows" },
      ],
    });
    expect(shown).toEqual([]);
    expect(localFlow()).toEqual({ nodes: [], edges: [] });
  });

  test("the local flow cannot be saved: said, reported, not counted", async () => {
    const { ports, shown } = world({ signedIn: false, localStoreFails: true });

    const report = await importFlowFile(flowFile("Blink"), ports);

    expect(report.messages).toEqual([
      { level: "error", title: "Couldn't import the flow", description: "IndexedDB will not open" },
    ]);
    expect((report.failure as Error).message).toBe("IndexedDB will not open");
    expect(report.imported).toBeUndefined();
    expect(shown).toEqual([]);
  });
});
