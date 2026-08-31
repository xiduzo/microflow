// The Ask AI write path is a trust boundary: a model invents field names,
// handles and enum values, and whatever it produces lands in the shared,
// persisted Yjs document. These assert the guards hold and — just as important —
// that a rejection comes back as a *result* the model can act on rather than a
// throw that kills the turn.

import { describe, expect, test } from "bun:test";
import { FlowDocument } from "@microflow/collab";

// `NODE_REGISTRY` pulls in every node component, and some of them read the web
// env at import time. Seed it before the dynamic import below — under `bun test`
// there is no Vite to supply it.
process.env.VITE_SERVER_URL ??= "http://localhost:3000";
const { applyChanges, createFlowTools } = await import("./flow-tools");
type PendingChange = import("./flow-tools").PendingChange;

type AnyTool = { name: string; execute: (input: never) => unknown };

function tools(mode: "auto" | "confirm" | "read-only" = "auto") {
  const doc = new FlowDocument();
  const staged: PendingChange[] = [];
  const list = createFlowTools(doc, {
    mode,
    stage: (change) => staged.push(change),
  }) as unknown as AnyTool[];
  const call = (name: string, input: unknown) => {
    const tool = list.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool '${name}' in ${mode} mode`);
    return tool.execute(input as never) as { ok: boolean; error?: string; detail?: string };
  };
  return { doc, staged, list, call };
}

describe("createFlowTools — writes", () => {
  test("adds a node with defaults filled in from its schema", () => {
    const { doc, call } = tools();
    const result = call("add_node", { type: "Led", data: { pin: 13 } });

    expect(result.ok).toBe(true);
    const nodes = doc.getNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("Led");
    expect(nodes[0].data.pin).toBe(13);
    // Untouched schema fields still arrive, so the node is complete for the
    // runtime rather than a partial the model happened to mention.
    expect(nodes[0].data.instance).toBe("Led");
  });

  test("rejects an unknown node type without throwing", () => {
    const { doc, call } = tools();
    const result = call("add_node", { type: "Teleporter" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown node type/i);
    expect(doc.getNodes()).toHaveLength(0);
  });

  test("rejects an enum value the node's own schema refuses", () => {
    const { doc, call } = tools();
    // `waveform` is a closed enum. This is the failure mode with history: a
    // value the runtime cannot deserialise reaches the document, persists in
    // Yjs, and surfaces later as an "unknown variant" error far from its cause.
    const result = call("add_node", { type: "Oscillator", data: { waveform: "banana" } });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid data for Oscillator/);
    expect(result.error).toMatch(/waveform/);
    expect(doc.getNodes()).toHaveLength(0);
  });

  test("rejects a wrongly-typed field", () => {
    const { doc, call } = tools();
    const result = call("add_node", { type: "Oscillator", data: { period: "fast" } });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/period/);
    expect(doc.getNodes()).toHaveLength(0);
  });
});

describe("createFlowTools — connect", () => {
  function twoNodes() {
    const ctx = tools();
    ctx.call("add_node", { type: "Button", data: { pin: 2 } });
    ctx.call("add_node", { type: "Led", data: { pin: 13 } });
    const [button, led] = ctx.doc.getNodes();
    return { ...ctx, button, led };
  }

  test("wires a declared emit to a declared port", () => {
    const { doc, call, button, led } = twoNodes();
    const result = call("connect", {
      source: button.id,
      sourceHandle: "true",
      target: led.id,
      targetHandle: "true",
    });

    expect(result.ok).toBe(true);
    expect(doc.getEdges()).toHaveLength(1);
    expect(doc.getEdges()[0].sourceHandle).toBe("true");
  });

  test("rejects a handle the component does not declare, and names the real ones", () => {
    const { doc, call, button, led } = twoNodes();
    const result = call("connect", {
      source: button.id,
      sourceHandle: "pressed", // Button emits "true"/"false"/…, never "pressed"
      target: led.id,
      targetHandle: "true",
    });

    expect(result.ok).toBe(false);
    // The error has to carry the valid set or the model cannot self-correct.
    expect(result.error).toMatch(/Button has no output 'pressed'/);
    expect(result.error).toMatch(/true/);
    expect(doc.getEdges()).toHaveLength(0);
  });

  test("rejects an edge to a node that is not there", () => {
    const { doc, call, button } = twoNodes();
    const result = call("connect", {
      source: button.id,
      sourceHandle: "true",
      target: "ghost",
      targetHandle: "true",
    });

    expect(result.ok).toBe(false);
    expect(doc.getEdges()).toHaveLength(0);
  });

  test("refuses to duplicate a connection", () => {
    const { doc, call, button, led } = twoNodes();
    const args = {
      source: button.id,
      sourceHandle: "true",
      target: led.id,
      targetHandle: "true",
    };
    call("connect", args);
    const second = call("connect", args);

    expect(second.ok).toBe(false);
    expect(doc.getEdges()).toHaveLength(1);
  });
});

describe("write modes", () => {
  test("read-only mode does not expose the write tools at all", () => {
    const { list } = tools("read-only");
    const names = list.map((t) => t.name);

    expect(names).toEqual(["get_flow", "get_diagnostics"]);
  });

  test("confirm mode stages instead of writing, and applying is one undo step", () => {
    const { doc, staged, call } = tools("confirm");

    expect(call("add_node", { type: "Led", data: { pin: 13 } }).ok).toBe(true);
    expect(call("add_node", { type: "Button", data: { pin: 2 } }).ok).toBe(true);
    // Nothing reached the document while the user had not answered.
    expect(doc.getNodes()).toHaveLength(0);
    expect(staged).toHaveLength(2);

    const before = doc.undoManager.undoStack.length;
    applyChanges(doc, staged);

    expect(doc.getNodes()).toHaveLength(2);
    // Both nodes went in under one transaction, so one undo takes them both.
    expect(doc.undoManager.undoStack.length).toBe(before + 1);
    doc.undoManager.undo();
    expect(doc.getNodes()).toHaveLength(0);
  });
});

// What a small local model actually sends. Each of these used to reach the
// framework's own input validation, which answers with a generic "input
// validation failed" — and llama3.2 responds to that by abandoning the tool API
// and typing its calls out as prose, so the flow never changes. Every one of
// them has to be answered by us, either by accepting it or by failing with
// advice the model can act on.
describe("createFlowTools — what models actually send", () => {
  test("accepts data sent as a JSON string", () => {
    const { doc, call } = tools();
    const result = call("add_node", { type: "Led", data: '{"pin": 13}' });

    expect(result.ok).toBe(true);
    expect(doc.getNodes()[0].data.pin).toBe(13);
  });

  test("rejects unparseable data with an example rather than a schema error", () => {
    const { call } = tools();
    const result = call("add_node", { type: "Led", data: "{pin:13, control:PinController}" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('{"pin": 13}');
  });

  test("accepts a lowercase node type", () => {
    const { doc, call } = tools();
    expect(call("add_node", { type: "led", data: { pin: 13 } }).ok).toBe(true);
    expect(doc.getNodes()[0].type).toBe("Led");
  });

  test("connect resolves a node referred to by its type name", () => {
    const { doc, call } = tools();
    call("add_node", { type: "Button", data: { pin: 2 } });
    call("add_node", { type: "Led", data: { pin: 13 } });

    const result = call("connect", {
      source: "Button",
      sourceHandle: "true",
      target: "Led",
      targetHandle: "toggle",
    });

    expect(result.ok).toBe(true);
    const [edge] = doc.getEdges();
    expect(edge.source).toBe(doc.getNodes()[0].id);
    expect(edge.target).toBe(doc.getNodes()[1].id);
  });

  test("a type name matching two nodes asks for an id instead of guessing", () => {
    const { call } = tools();
    call("add_node", { type: "Button", data: { pin: 2 } });
    call("add_node", { type: "Led", data: { pin: 13 } });
    call("add_node", { type: "Led", data: { pin: 12 } });

    const result = call("connect", {
      source: "Button",
      sourceHandle: "true",
      target: "Led",
      targetHandle: "toggle",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("2 Led nodes");
  });
});
