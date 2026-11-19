// The Ask AI write path is a trust boundary: a model invents field names,
// handles and enum values, and whatever it produces lands in the shared,
// persisted Yjs document. These assert the guards hold and — just as important —
// that a rejection comes back as a *result* the model can act on rather than a
// throw that kills the turn.

import { describe, expect, test } from "bun:test";
import { FlowDocument } from "@microflow/collab";

import { applyChanges, createFlowTools, type PendingChange } from "./flow-tools";

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

  /** A Counter to wire from, and one node of `type` to wire to. */
  function counterAnd(type: string, data: Record<string, unknown>) {
    const ctx = tools();
    ctx.call("add_node", { type: "Counter" });
    ctx.call("add_node", { type, data });
    const [counter, node] = ctx.doc.getNodes();
    const into = (targetHandle: string) =>
      ctx.call("connect", { source: counter.id, sourceHandle: "value", target: node.id, targetHandle });
    return { ...ctx, counter, node, into };
  }

  test("wires an open port: a {{variable}} the node's own settings name", () => {
    const { doc, into } = counterAnd("Function", { code: "return {{speed}} * 2;" });

    expect(into("speed").ok).toBe(true);
    expect(doc.getEdges()[0].targetHandle).toBe("speed");
  });

  test("rejects a variable the node's settings do not name", () => {
    const { doc, into } = counterAnd("Function", { code: "return {{speed}} * 2;" });
    const result = into("volume");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/trigger, speed/);
    expect(doc.getEdges()).toHaveLength(0);
  });

  test("rejects a handle the node does not offer with its current settings", () => {
    // `min` is a Servo port, but only a standard servo has it.
    const { doc, into } = counterAnd("Servo", { type: "continuous" });
    const result = into("min");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Servo has no input 'min' with its current settings/);
    expect(result.error).toMatch(/value, stop/);
    expect(doc.getEdges()).toHaveLength(0);
  });

  test("rejects `read` on a Button, a port it does not have", () => {
    // Button and the other sensor nodes do not declare `read`: the runtime
    // refuses an edge into it and the canvas has no such handle.
    const { doc, into } = counterAnd("Button", { pin: 2 });

    expect(into("read").ok).toBe(false);
    expect(doc.getEdges()).toHaveLength(0);
  });

  test("rejects an output the node does not offer in its direction", () => {
    const ctx = tools();
    ctx.call("add_node", { type: "Mqtt", data: { direction: "publish" } });
    ctx.call("add_node", { type: "Monitor" });
    const [mqtt, monitor] = ctx.doc.getNodes();
    const result = ctx.call("connect", {
      source: mqtt.id,
      sourceHandle: "value",
      target: monitor.id,
      targetHandle: "value",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Mqtt has no output 'value' with its current settings/);
    expect(ctx.doc.getEdges()).toHaveLength(0);
  });

  test("a port no settings offer is refused without sending the model after a setting", () => {
    // `rotate` is declared by the Servo component and never offered.
    const { into } = counterAnd("Servo", { type: "continuous" });
    const result = into("rotate");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Servo has no input 'rotate' — it accepts: value, stop/);
  });
});

describe("createFlowTools — confirm mode builds on what the turn has staged", () => {
  /** `confirm`-mode tools over a flow that already holds a Counter (`src`) and `node`. */
  function staging(type: string, data: Record<string, unknown>) {
    const doc = new FlowDocument();
    doc.addNode({ id: "src", type: "Counter", position: { x: 0, y: 0 }, data: {} });
    doc.addNode({ id: "node", type, position: { x: 0, y: 0 }, data });
    doc.addNode({ id: "sink", type: "Monitor", position: { x: 0, y: 0 }, data: {} });
    const staged: PendingChange[] = [];
    const list = createFlowTools(doc, {
      mode: "confirm",
      stage: (change) => staged.push(change),
    }) as unknown as AnyTool[];
    const call = (name: string, input: unknown) =>
      list.find((t) => t.name === name)!.execute(input as never) as {
        ok: boolean;
        error?: string;
        detail?: string;
      };
    const into = (targetHandle: string) =>
      call("connect", { source: "src", sourceHandle: "value", target: "node", targetHandle });
    return { doc, staged, call, into };
  }

  test.each([
    ["Mqtt", { direction: "subscribe" }, { direction: "publish" }, "trigger"],
    ["Servo", { type: "standard" }, { type: "continuous" }, "stop"],
    ["Midi", { direction: "in" }, { direction: "out" }, "send"],
    ["Figma", { resolvedType: "STRING" }, { resolvedType: "COLOR" }, "red"],
  ])("%s: a staged setting makes its handle connectable", (type, before, change, handle) => {
    const { doc, staged, call, into } = staging(type, before);

    // Not yet: the node does not have the handle as it is configured.
    expect(into(handle).ok).toBe(false);

    expect(call("update_node_data", { nodeId: "node", data: change }).ok).toBe(true);
    const connected = into(handle);
    expect(connected.error).toBeUndefined();
    expect(connected.ok).toBe(true);

    // Nothing reached the document while the user had not answered.
    expect(doc.getEdges()).toHaveLength(0);
    expect(doc.getNode("node")?.data).toEqual(before);

    applyChanges(doc, staged);
    expect(doc.getNode("node")?.data).toMatchObject(change);
    expect(doc.getEdges().map((edge) => edge.targetHandle)).toEqual([handle]);
  });

  test("a connect that is valid now is refused once a staged setting takes the handle away", () => {
    const { doc, staged, call, into } = staging("Mqtt", { direction: "publish" });

    call("update_node_data", { nodeId: "node", data: { direction: "subscribe" } });
    const result = into("trigger");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Mqtt has no input 'trigger' with its current settings/);
    // The subscribing node's output is connectable instead.
    expect(
      call("connect", { source: "node", sourceHandle: "value", target: "sink", targetHandle: "value" }).ok,
    ).toBe(true);

    applyChanges(doc, staged);
    expect(doc.getEdges().map((edge) => edge.sourceHandle)).toEqual(["value"]);
  });

  test("a staged node can be wired before it exists", () => {
    const { doc, staged, call } = staging("Monitor", {});

    const added = call("add_node", { type: "Mqtt", data: { direction: "publish" } });
    const id = /\(id (\w+)\)/.exec(added.detail ?? "")?.[1];
    expect(id).toBeDefined();

    const wired = call("connect", {
      source: "src",
      sourceHandle: "value",
      target: id,
      targetHandle: "trigger",
    });
    expect(wired.ok).toBe(true);
    // The same connection again is a duplicate of the staged one.
    expect(
      call("connect", { source: "src", sourceHandle: "value", target: id, targetHandle: "trigger" }).ok,
    ).toBe(false);

    applyChanges(doc, staged);
    expect(doc.getEdges().map((edge) => [edge.target, edge.targetHandle])).toEqual([[id, "trigger"]]);
  });

  test("two staged updates to one node compose", () => {
    const { doc, staged, call, into } = staging("Midi", { direction: "in", mode: "note" });

    call("update_node_data", { nodeId: "node", data: { mode: "cc" } });
    call("update_node_data", { nodeId: "node", data: { direction: "out" } });
    expect(into("send").ok).toBe(true);

    applyChanges(doc, staged);
    expect(doc.getNode("node")?.data).toMatchObject({ direction: "out", mode: "cc" });
  });

  test("a node staged for deletion can no longer be wired", () => {
    const { call, into } = staging("Monitor", {});

    expect(call("delete_node", { nodeId: "node" }).ok).toBe(true);
    expect(into("value").ok).toBe(false);
  });

  test("a staged setting that takes a handle away takes the edge staged at it too", () => {
    // Applied as one transaction, the node ends where it began, so nothing
    // after the fact would notice the edge. The same three calls in auto mode
    // leave no edge, and so must an approval.
    const { doc, staged, call, into } = staging("Mqtt", { direction: "subscribe" });

    call("update_node_data", { nodeId: "node", data: { direction: "publish" } });
    expect(into("trigger").ok).toBe(true);
    const back = call("update_node_data", { nodeId: "node", data: { direction: "subscribe" } });

    expect(back.detail).toContain("removed connection Counter.value → Mqtt.trigger");
    applyChanges(doc, staged);
    expect(doc.getNode("node")?.data).toMatchObject({ direction: "subscribe" });
    expect(doc.getEdges()).toEqual([]);
  });

  test("an edge an approval will remove is on the list the user approves", () => {
    const { doc, staged, call } = staging("Mqtt", { direction: "publish" });
    doc.addEdge({ id: "wired", source: "src", sourceHandle: "value", target: "node", targetHandle: "trigger" });

    call("update_node_data", { nodeId: "node", data: { direction: "subscribe" } });

    expect(staged.map((change) => change.summary)).toEqual([
      "updated Mqtt node (direction)",
      "removed connection Counter.value → Mqtt.trigger (Mqtt node no longer has that input)",
    ]);
    // Nothing is removed before the user says so.
    expect(doc.getEdgeIds()).toEqual(["wired"]);

    applyChanges(doc, staged);
    expect(doc.getEdges()).toEqual([]);
  });

  test("an edge at a handle the node keeps is not on that list", () => {
    const { doc, staged, call } = staging("Servo", { type: "standard" });
    doc.addEdge({ id: "to-value", source: "src", sourceHandle: "value", target: "node", targetHandle: "value" });
    doc.addEdge({ id: "to-min", source: "src", sourceHandle: "value", target: "node", targetHandle: "min" });

    call("update_node_data", { nodeId: "node", data: { type: "continuous" } });

    expect(staged.map((change) => change.summary)).toEqual([
      "updated Servo node (type)",
      "removed connection Counter.value → Servo.min (Servo node no longer has that input)",
    ]);
    applyChanges(doc, staged);
    expect(doc.getEdgeIds()).toEqual(["to-value"]);
  });

  test("get_flow shows what the turn has staged", () => {
    const { doc, call, into } = staging("Mqtt", { direction: "subscribe" });

    call("update_node_data", { nodeId: "node", data: { direction: "publish" } });
    into("trigger");
    const added = call("add_node", { type: "Led", data: { pin: 13 } });
    const ledId = /\(id (\w+)\)/.exec(added.detail ?? "")?.[1];

    const flow = call("get_flow", {}) as unknown as {
      nodes: { id: string; type: string; data: Record<string, unknown> }[];
      edges: { target: string; targetHandle: string }[];
    };
    expect(flow.nodes.find((node) => node.id === "node")?.data).toMatchObject({ direction: "publish" });
    expect(flow.nodes.map((node) => node.id)).toContain(ledId);
    expect(flow.edges.map((edge) => `${edge.target}.${edge.targetHandle}`)).toEqual(["node.trigger"]);
    // The document itself is untouched.
    expect(doc.getNode("node")?.data).toEqual({ direction: "subscribe" });
    expect(doc.getEdges()).toEqual([]);
  });

  test("a handle that follows from something the model cannot set is refused with that said", () => {
    const { into } = staging("Figma", { resolvedType: "STRING" });
    const result = into("red");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("it accepts: set");
    expect(result.error).toContain("follow the type of the design variable");
  });
});

describe("createFlowTools — update_node_data in auto mode", () => {
  test("removes the edges of a handle the new settings take away, and says so", () => {
    // No session here, so nothing else would: the tool's own edit does it.
    const { doc, call } = tools();
    call("add_node", { type: "Counter" });
    call("add_node", { type: "Mqtt", data: { direction: "publish" } });
    const [counter, mqtt] = doc.getNodes();
    call("connect", { source: counter.id, sourceHandle: "value", target: mqtt.id, targetHandle: "trigger" });
    expect(doc.getEdges()).toHaveLength(1);

    const result = call("update_node_data", { nodeId: mqtt.id, data: { direction: "subscribe" } });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("removed connection Counter.value → Mqtt.trigger");
    expect(doc.getEdges()).toEqual([]);
  });

  test("leaves every edge alone when the handles stay", () => {
    const { doc, call } = tools();
    call("add_node", { type: "Counter" });
    call("add_node", { type: "Mqtt", data: { direction: "publish" } });
    const [counter, mqtt] = doc.getNodes();
    call("connect", { source: counter.id, sourceHandle: "value", target: mqtt.id, targetHandle: "trigger" });

    const result = call("update_node_data", { nodeId: mqtt.id, data: { topic: "lights" } });

    expect(result.detail).not.toContain("removed");
    expect(doc.getEdges()).toHaveLength(1);
  });
});

describe("createFlowTools — delete_node", () => {
  test("takes the node's edges with it, as its description promises", () => {
    const { doc, call } = tools();
    call("add_node", { type: "Button", data: { pin: 2 } });
    call("add_node", { type: "Led", data: { pin: 13 } });
    const [button, led] = doc.getNodes();
    call("connect", { source: button.id, sourceHandle: "true", target: led.id, targetHandle: "true" });

    const result = call("delete_node", { nodeId: led.id });

    expect(result.ok).toBe(true);
    expect(doc.hasNode(led.id)).toBe(false);
    // No edge left pointing at a node that is gone — the runtime, codegen and
    // the model's next get_flow would all still read it.
    expect(doc.getEdges()).toHaveLength(0);
  });

  test("undoes as one step, node and edges together", () => {
    const { doc, call } = tools();
    call("add_node", { type: "Button", data: { pin: 2 } });
    call("add_node", { type: "Led", data: { pin: 13 } });
    const [button, led] = doc.getNodes();
    call("connect", { source: button.id, sourceHandle: "true", target: led.id, targetHandle: "true" });
    // Seal the setup into its own undo group.
    doc.undoManager.stopCapturing();

    call("delete_node", { nodeId: button.id });
    doc.undo();

    expect(doc.hasNode(button.id)).toBe(true);
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
